/**
 * Content-Security-Policy with a per-request nonce (security hardening, owner request 2026-10-07). Built in the
 * middleware for every page request and passed to the app as `x-nonce` + `content-security-policy` request headers:
 * Next.js puts the nonce on its own scripts, `<ClerkProvider dynamic>` reads `X-Nonce` for the Clerk script, and the
 * root layout puts it on the theme boot script.
 *
 * - `script-src 'nonce-…' 'strict-dynamic'`: only scripts this server rendered (and what they load) run. An injected
 *   `<script>` or inline handler has no nonce and is refused. `https:` / `'unsafe-inline'` are listed only as fallbacks
 *   for old browsers; a browser that understands nonces ignores both.
 * - Clerk: its frontend-API host (from the publishable key) for the SDK's requests, Cloudflare Turnstile for bot
 *   protection, `img.clerk.com` for avatars.
 * - `style-src 'unsafe-inline'`: React `style` attributes and Clerk's runtime styles need it; styles cannot run code.
 * - `img-src https:`: restaurants' own images come from the hosts they configured (allow-listed server-side).
 * - Development adds `'unsafe-eval'` (React refresh) and `ws:` (hot reload); production adds `upgrade-insecure-requests`.
 */
export type CspOptions = { nonce: string; production: boolean; clerkFrontendApi: string | null };

export function contentSecurityPolicy({ nonce, production, clerkFrontendApi }: CspOptions): string {
  const clerk = clerkFrontendApi ? [`https://${clerkFrontendApi}`] : [];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "https:", "'unsafe-inline'", ...(production ? [] : ["'unsafe-eval'"])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...clerk, "https://clerk-telemetry.com", "https://*.clerk-telemetry.com", ...(production ? [] : ["ws:", "wss:"])],
    "frame-src": ["'self'", "https://challenges.cloudflare.com"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (production) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/** The Clerk frontend-API host encoded in a publishable key (`pk_test_…` / `pk_live_…`), or null. */
export function clerkFrontendApiFromKey(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.match(/^pk_(?:test|live)_(.+)$/)?.[1];
  if (!encoded) return null;
  try {
    const host = atob(encoded).replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** 128 random bits, base64 — fresh for every request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
