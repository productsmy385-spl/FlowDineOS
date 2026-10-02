/**
 * Route policy for the middleware (S1-P03-T002, security.md §2.2). Pure functions: no Clerk, no Next.js imports,
 * so the decision table is unit-tested directly.
 *
 * The middleware is a coarse gate only (SC-AUTH-04): every loader, action and route handler still resolves the
 * session and permissions itself. Public routes never grant tenant data.
 */

export type RouteKind =
  | "public" // no session needed (marketing, public menu, sign-in, health)
  | "agent" // print-agent API: bearer-token auth in the handler, never a Clerk session (ADR-007)
  | "webhook" // Clerk webhook: Svix signature in the handler (ADR-011)
  | "api" // session API: 401 JSON when signed out
  | "page"; // everything else: redirect to /sign-in when signed out

// `/sitemap.xml` and `/robots.txt` are generated from published public websites only (LD-PUB-03, S1-P09-T005).
const PUBLIC_EXACT = new Set(["/", "/offline", "/api/health", "/api/ready", "/manifest.json", "/sw.js", "/favicon.ico", "/robots.txt", "/sitemap.xml"]);
// `/staff-login` is public in the same sense as `/sign-in`: it is the door, not what is behind it. The daily
// password is checked server-side and rate limited there (RASOIOS-ADR-019 §5).
const PUBLIC_PREFIXES = ["/r/", "/sign-in", "/sign-up", "/staff-login", "/icons/"];

/**
 * Paths that sit under a public prefix but are not public. `/sign-in/landing` reads the caller's platform role and
 * memberships and sends each user somewhere different, so it is an ordinary signed-in page that happens to live under
 * `/sign-in`. Classifying it `public` gave its per-user redirect no `no-store`, so a browser could replay the redirect
 * it received while signed out — back to `/sign-in` — and the sign-in form appeared to hang until a manual reload.
 */
const PRIVATE_EXACT = new Set(["/sign-in/landing"]);

function matchesPrefix(pathname: string, prefix: string): boolean {
  // "/sign-in" matches "/sign-in" and "/sign-in/…" but not "/sign-inx".
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function classifyRoute(pathname: string): RouteKind {
  if (pathname === "/api/webhooks/clerk") return "webhook";
  if (pathname === "/api/v1/print-agent" || pathname.startsWith("/api/v1/print-agent/")) return "agent";
  if (PRIVATE_EXACT.has(pathname)) return "page";
  if (PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => matchesPrefix(pathname, p))) return "public";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  return "page";
}

/**
 * Whether a response for this path must carry `Cache-Control: no-store` (S1-P09-T007, TC-SEC-006, SC-PUB-02).
 *
 * Everything that is not a public route is answered from a session or a bearer token, so it is one user's — or one
 * restaurant's — data. Without this a shared cache (a corporate proxy, a CDN put in front of the app, the browser's
 * back/forward cache) may hold a console page rendered for one person and hand it to the next.
 *
 * Public routes are deliberately excluded: `/r/{slug}` is the same page for everyone and is served from the ISR cache
 * with `revalidate = 60` (api.md §7), which `no-store` would defeat.
 */
export function mustNotBeStored(pathname: string): boolean {
  return classifyRoute(pathname) !== "public";
}

/**
 * The staff daily-password cookie, as the middleware sees it (RASOIOS-ADR-019 section 4). Defined here, in the pure
 * policy module, because the middleware runs on the edge and cannot import `node:crypto`; `staff-session-cookie.ts`
 * takes the name from here so there is one source.
 */
export const STAFF_SESSION_COOKIE_NAME = "rasoi_staff_session";
const STAFF_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a request presents something shaped like a staff session. This is the coarse gate only (SC-AUTH-04): it
 * proves nothing about the token, which every page, action and route handler then checks against the database via
 * `getSessionUser`. Its job is narrower: before this, the gate knew only Clerk, so a cashier who had just signed in
 * with today's password was bounced from /restaurant straight back to /sign-in, and asked for it again, forever.
 */
export function presentsStaffSession(cookieValue: string | null | undefined): boolean {
  return typeof cookieValue === "string" && STAFF_TOKEN_SHAPE.test(cookieValue);
}

export type GateDecision =
  | { action: "next" }
  | { action: "redirect"; location: string }
  | { action: "json"; status: 401; body: { error: { code: "UNAUTHENTICATED"; message: string; requestId: string } } };

/** What the middleware does for a request, given whether a Clerk session is present. */
export function gate(pathname: string, search: string, signedIn: boolean, requestId: string): GateDecision {
  const kind = classifyRoute(pathname);
  if (kind === "public" || kind === "agent" || kind === "webhook" || signedIn) return { action: "next" };
  if (kind === "api") {
    return { action: "json", status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Sign in to continue.", requestId } } };
  }
  const target = `${pathname}${search}`;
  return { action: "redirect", location: `/sign-in?redirect_url=${encodeURIComponent(target)}` };
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Keeps a well-formed incoming `x-request-id` (e.g. from Railway's proxy); otherwise generates a UUID. */
export function ensureRequestId(incoming: string | null | undefined, generate: () => string): string {
  return incoming && REQUEST_ID.test(incoming) ? incoming : generate();
}
