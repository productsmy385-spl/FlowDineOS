import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { clerkFrontendApiFromKey, contentSecurityPolicy, newNonce } from "@/lib/http/content-security-policy";
import { STAFF_SESSION_COOKIE_NAME, ensureRequestId, gate, mustNotBeStored, presentsStaffSession } from "@/lib/auth/route-policy";
import {
  TENANT_SLUG_HEADER,
  UNRESOLVABLE_PUBLIC_PATH,
  apexAuthorityFor,
  isApexOnlyPath,
  isHostNeutralPath,
  normalizeRootDomain,
  publicRewritePath,
  resolveHost,
} from "@/lib/tenancy/hostnames";

/**
 * Host resolution (S1-P09-T011, RASOIOS-ADR-012) and the fail-closed authentication gate (S1-P03-T002, SC-AUTH-02/03).
 *
 * Host first, then authentication:
 * - `<slug>.<PUBLIC_ROOT_DOMAIN>` and `<slug>.localhost` are tenant hosts. Their requests are rewritten to
 *   `/r/{slug}…` and the resolved slug is handed to the app in an internal header that the middleware always sets or
 *   deletes, so a client-supplied `x-rasoi-tenant-slug` never survives the edge (ADR-012 §1). Public pages therefore
 *   need no Clerk round-trip.
 * - Console, platform, account, authentication and `/r/{slug}` paths are apex-only: on a tenant host they redirect to
 *   the same path on the apex host, which keeps one Clerk domain and one session cookie (ADR-012 §6).
 * - APIs, framework assets and well-known files behave identically on every host.
 * - A host that is meant to be a tenant but cannot be one (bad label, multi-label subdomain) renders the same public
 *   404 as an unknown slug, a suspended tenant and an unpublished website (ADR-012 §7).
 * - `PUBLIC_ROOT_DOMAIN` is optional: unset, only `*.localhost` resolves and everything else is the apex host.
 *
 * Then, as before: Clerk runs on every remaining request; signed-out page requests redirect to /sign-in with a
 * same-origin `redirect_url`, signed-out API requests get 401 JSON, and a Clerk verification failure is 503, never
 * "signed out" (SC-AUTH-09). Every request carries an `x-request-id`.
 */
export default clerkMiddleware(async (auth, req) => {
  const requestId = ensureRequestId(req.headers.get("x-request-id"), () => crypto.randomUUID());
  const { pathname, search } = req.nextUrl;
  // A fresh script nonce per request (lib/http/content-security-policy.ts). The app reads it from the request headers
  // set below; a client-supplied `x-nonce` or CSP header is always overwritten.
  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, production: process.env.NODE_ENV === "production", clerkFrontendApi: clerkFrontendApiFromKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) });
  const withCsp = (headers: Headers) => {
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return headers;
  };

  const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN);
  const host = resolveHost(req.headers.get("host"), rootDomain);

  if (host.kind !== "apex" && !isHostNeutralPath(pathname)) {
    if (isApexOnlyPath(pathname)) {
      const authority = apexAuthorityFor(req.headers.get("host"), rootDomain);
      if (authority !== null) {
        const target = new URL(`${pathname}${search}`, req.url);
        target.host = authority;
        const response = NextResponse.redirect(target, 308);
        response.headers.set("x-request-id", requestId);
        return response;
      }
    } else {
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      if (host.kind === "tenant") headers.set(TENANT_SLUG_HEADER, host.slug);
      else headers.delete(TENANT_SLUG_HEADER);
      const destination = host.kind === "tenant" ? publicRewritePath(host.slug, pathname) : UNRESOLVABLE_PUBLIC_PATH;
      const response = NextResponse.rewrite(new URL(`${destination}${search}`, req.url), { request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      return response;
    }
  }

  let signedIn: boolean;
  try {
    signedIn = Boolean((await auth()).userId);
  } catch {
    const body = { error: { code: "SERVICE_UNAVAILABLE", message: "We couldn't verify your session. Try again.", requestId } };
    return NextResponse.json(body, { status: 503, headers: { "x-request-id": requestId, "retry-after": "5" } });
  }

  // A daily-password staff session counts as signed in at this coarse gate; the page or handler behind it checks the
  // token against the database on every request, so a revoked or expired one is still refused there (ADR-019).
  const staffSession = presentsStaffSession(req.cookies.get(STAFF_SESSION_COOKIE_NAME)?.value);
  const decision = gate(pathname, search, signedIn || staffSession, requestId);
  if (decision.action === "redirect") {
    const response = NextResponse.redirect(new URL(decision.location, req.url));
    response.headers.set("x-request-id", requestId);
    return response;
  }
  if (decision.action === "json") {
    return NextResponse.json(decision.body, { status: decision.status, headers: { "x-request-id": requestId } });
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  // Apex host and host-neutral paths never carry a tenant slug: a client-supplied header is dropped here.
  headers.delete(TENANT_SLUG_HEADER);
  const response = NextResponse.next({ request: { headers: withCsp(headers) } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("content-security-policy", csp);
  // Session- and token-authenticated responses are one user's data; a shared cache must never hand them to the next
  // person (SC-PUB-02, TC-SEC-006). Public pages keep their ISR caching.
  if (mustNotBeStored(pathname)) response.headers.set("cache-control", "no-store");
  return response;
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|json|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
