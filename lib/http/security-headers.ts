/**
 * Response security headers for every route (security hardening brief 2026-10-07). Applied from `next.config.ts`.
 *
 * The Content-Security-Policy restricts what cannot break Next.js or Clerk: no framing of any page (clickjacking on the
 * consoles and the payment screens), no plugins, no `<base>` rewriting, and forms post only to this origin. Script and
 * style sources are not restricted yet: Next.js inline bootstrap scripts and Clerk's per-instance frontend API host need
 * a per-request nonce first (recorded as a follow-up in knowledge/implementation/slice-01/security.md).
 *
 * HSTS and `upgrade-insecure-requests` are production only, so `http://localhost` and `{slug}.localhost` keep working.
 */
export type HeaderPair = { key: string; value: string };

export function securityHeaders(production: boolean): HeaderPair[] {
  const csp = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", ...(production ? ["upgrade-insecure-requests"] : [])].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  ];
}
