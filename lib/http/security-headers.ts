/**
 * Response security headers for every route (security hardening brief 2026-10-07). Applied from `next.config.ts`.
 *
 * The Content-Security-Policy is not here: it carries a per-request script nonce, so the middleware builds it
 * (`lib/http/content-security-policy.ts`).
 *
 * HSTS is production only, so `http://localhost` and `{slug}.localhost` keep working.
 */
export type HeaderPair = { key: string; value: string };

export function securityHeaders(production: boolean): HeaderPair[] {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  ];
}
