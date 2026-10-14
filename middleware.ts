import { clerkMiddleware } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { clerkFrontendApiFromKey, contentSecurityPolicy, newNonce } from "@/lib/http/content-security-policy";
import { STAFF_SESSION_COOKIE_NAME, ensureRequestId, gate, mustNotBeStored, presentsStaffSession } from "@/lib/auth/route-policy";
import {
  TENANT_SLUG_HEADER,
  UNRESOLVABLE_PUBLIC_PATH,
  apexAuthorityFor,
  hostPort,
  isHostNeutralPath,
  normalizeHost,
  normalizeRootDomain,
  publicRewritePath,
  resolveHost,
} from "@/lib/tenancy/hostnames";

/** Safe public redirect URL that never leaks internal ports (e.g. 8080) on public domains */
function publicRedirectUrl(location: string, req: NextRequest, targetHost?: string): URL {
  const rawHost = targetHost || req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host || "flowdine.in";
  const host = normalizeHost(rawHost) || "flowdine.in";
  const isLocal = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1";
  const proto = isLocal ? (req.headers.get("x-forwarded-proto") || (req.url.startsWith("https") ? "https" : "http")) : "https";
  const port = hostPort(rawHost);
  const portSuffix = isLocal && port ? `:${port}` : "";
  const base = `${proto}://${host}${portSuffix}`;
  return new URL(location, base);
}

/** Sanitize request headers forwarded downstream to Next.js Server Components so redirect() never sees internal ports */
function sanitizeForwardedHeaders(headers: Headers, req: NextRequest): Headers {
  const rawHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || "flowdine.in";
  const host = normalizeHost(rawHost) || "flowdine.in";
  const isLocal = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1";

  if (!isLocal) {
    headers.set("host", host);
    headers.set("x-forwarded-host", host);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-port", "443");
  }
  return headers;
}

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
    headers.set("x-pathname", `${pathname}${search}`);
    return sanitizeForwardedHeaders(headers, req);
  };

  const rootDomain = normalizeRootDomain(process.env.PUBLIC_ROOT_DOMAIN);
  const host = resolveHost(req.headers.get("host"), rootDomain);

  let signedIn = false;
  try {
    signedIn = Boolean((await auth()).userId);
  } catch {
    const body = { error: { code: "SERVICE_UNAVAILABLE", message: "We couldn't verify your session. Try again.", requestId } };
    return NextResponse.json(body, { status: 503, headers: { "x-request-id": requestId, "retry-after": "5" } });
  }

  const staffSession = presentsStaffSession(req.cookies.get(STAFF_SESSION_COOKIE_NAME)?.value);

  // Tenant subdomains (e.g. akshayapatra.flowdine.in or akshayapatra.localhost)
  if (host.kind === "tenant" && !isHostNeutralPath(pathname)) {
    // 1. Staff login: /staff-login is canonical; /staff/login redirects 308 to /staff-login
    if (pathname === "/staff/login" || pathname === "/staff/login/") {
      const response = NextResponse.redirect(publicRedirectUrl(`/staff-login${search}`, req), 308);
      response.headers.set("x-request-id", requestId);
      return response;
    }
    if (pathname === "/staff-login" || pathname === "/staff-login/") {
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      headers.set(TENANT_SLUG_HEADER, host.slug);
      const response = NextResponse.rewrite(new URL(`/staff-login${search}`, req.url), { request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      return response;
    }

    // 2. Tenant dashboard alias (/dashboard -> /restaurant/dashboard)
    if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
      if (!signedIn && !staffSession) {
        const response = NextResponse.redirect(publicRedirectUrl(`/staff-login`, req));
        response.headers.set("x-request-id", requestId);
        return response;
      }
      const rest = pathname === "/dashboard" || pathname === "/dashboard/" ? "" : pathname.slice("/dashboard".length);
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      headers.set(TENANT_SLUG_HEADER, host.slug);
      const response = NextResponse.rewrite(new URL(`/restaurant/dashboard${rest}${search}`, req.url), { request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      response.headers.set("cache-control", "no-store");
      return response;
    }

    // 3. Tenant console (/restaurant/...) on tenant host
    if (pathname === "/restaurant" || pathname.startsWith("/restaurant/")) {
      if (!signedIn && !staffSession) {
        const response = NextResponse.redirect(publicRedirectUrl(`/staff-login`, req));
        response.headers.set("x-request-id", requestId);
        return response;
      }
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      headers.set(TENANT_SLUG_HEADER, host.slug);
      const response = NextResponse.next({ request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      response.headers.set("cache-control", "no-store");
      return response;
    }

    // 4. Platform apex-only paths (admin, account, sign-in, sign-up) -> redirect to apex
    if (
      pathname.startsWith("/admin") ||
      pathname.startsWith("/account") ||
      pathname === "/sign-in" ||
      pathname.startsWith("/sign-in/") ||
      pathname === "/sign-up" ||
      pathname.startsWith("/sign-up/")
    ) {
      const authority = apexAuthorityFor(req.headers.get("host"), rootDomain);
      if (authority !== null) {
        const cleanAuthority = normalizeHost(authority) || "flowdine.in";
        const response = NextResponse.redirect(publicRedirectUrl(`${pathname}${search}`, req, cleanAuthority), 308);
        response.headers.set("x-request-id", requestId);
        return response;
      }
    }

    // 5. Legacy /r/... path on tenant host -> 308 redirect to clean subdomain path
    if (pathname.startsWith("/r/")) {
      const isLegacyDbSlug = host.slug === "akshayapatra" && (pathname === "/r/akshayapatra-devarapalli" || pathname.startsWith("/r/akshayapatra-devarapalli/"));
      const isThisTenant = pathname === `/r/${host.slug}` || pathname.startsWith(`/r/${host.slug}/`) || isLegacyDbSlug;
      if (isThisTenant) {
        const prefix = isLegacyDbSlug ? "/r/akshayapatra-devarapalli" : `/r/${host.slug}`;
        const subPath = pathname.slice(prefix.length) || "/";
        const response = NextResponse.redirect(publicRedirectUrl(`${subPath}${search}`, req), 308);
        response.headers.set("x-request-id", requestId);
        return response;
      }
      const authority = apexAuthorityFor(req.headers.get("host"), rootDomain);
      if (authority !== null) {
        const cleanAuthority = normalizeHost(authority) || "flowdine.in";
        const response = NextResponse.redirect(publicRedirectUrl(`${pathname}${search}`, req, cleanAuthority), 308);
        response.headers.set("x-request-id", requestId);
        return response;
      }
    }

    // 6. Public menu and daily aliases
    if (pathname === "/menu" || pathname === "/menu/") {
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      headers.set(TENANT_SLUG_HEADER, host.slug);
      const response = NextResponse.rewrite(new URL(`/r/${host.slug}/menu${search}`, req.url), { request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      return response;
    }
    if (pathname === "/daily" || pathname === "/daily/") {
      const headers = new Headers(req.headers);
      headers.set("x-request-id", requestId);
      headers.set(TENANT_SLUG_HEADER, host.slug);
      const response = NextResponse.rewrite(new URL(`/r/${host.slug}/daily${search}`, req.url), { request: { headers: withCsp(headers) } });
      response.headers.set("x-request-id", requestId);
      response.headers.set("content-security-policy", csp);
      return response;
    }

    // 7. General public website rewrite (/ -> /r/{slug}, etc.)
    const headers = new Headers(req.headers);
    headers.set("x-request-id", requestId);
    headers.set(TENANT_SLUG_HEADER, host.slug);
    const destination = publicRewritePath(host.slug, pathname);
    const response = NextResponse.rewrite(new URL(`${destination}${search}`, req.url), { request: { headers: withCsp(headers) } });
    response.headers.set("x-request-id", requestId);
    response.headers.set("content-security-policy", csp);
    return response;
  }

  // Invalid tenant subdomain
  if (host.kind === "invalid" && !isHostNeutralPath(pathname)) {
    const headers = new Headers(req.headers);
    headers.set("x-request-id", requestId);
    headers.delete(TENANT_SLUG_HEADER);
    const response = NextResponse.rewrite(new URL(`${UNRESOLVABLE_PUBLIC_PATH}${search}`, req.url), { request: { headers: withCsp(headers) } });
    response.headers.set("x-request-id", requestId);
    response.headers.set("content-security-policy", csp);
    return response;
  }

  // Apex host or host-neutral paths
  if (pathname.startsWith("/r/")) {
    const effectiveRoot = rootDomain ?? (req.headers.get("host")?.includes("flowdine.in") ? "flowdine.in" : null);
    if (effectiveRoot && process.env.NODE_ENV !== "test") {
      const remainder = pathname.slice(3); // after /r/
      const slashIndex = remainder.indexOf("/");
      const slug = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
      const subPath = slashIndex === -1 ? "/" : remainder.slice(slashIndex);
      const targetSub = slug === "akshayapatra-devarapalli" ? "akshayapatra" : slug;
      if (targetSub && targetSub !== "_") {
        const cleanRoot = normalizeHost(effectiveRoot) || "flowdine.in";
        const response = NextResponse.redirect(publicRedirectUrl(`${subPath}${search}`, req, `${targetSub}.${cleanRoot}`), 308);
        response.headers.set("x-request-id", requestId);
        return response;
      }
    }
  }

  const decision = gate(pathname, search, signedIn || staffSession, requestId);
  if (decision.action === "redirect") {
    const response = NextResponse.redirect(publicRedirectUrl(decision.location, req));
    response.headers.set("x-request-id", requestId);
    return response;
  }
  if (decision.action === "json") {
    return NextResponse.json(decision.body, { status: decision.status, headers: { "x-request-id": requestId } });
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  if (host.kind === "tenant") headers.set(TENANT_SLUG_HEADER, host.slug);
  else headers.delete(TENANT_SLUG_HEADER);

  const response = NextResponse.next({ request: { headers: withCsp(headers) } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("content-security-policy", csp);
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
