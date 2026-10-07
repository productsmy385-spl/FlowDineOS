import { describe, expect, it } from "vitest";
import { securityHeaders } from "@/lib/http/security-headers";

// TC-SEC-HDR-001 — every response carries the hardening headers; HSTS and upgrade-insecure-requests only in production
// (security hardening brief 2026-10-07).
const asMap = (production: boolean) => Object.fromEntries(securityHeaders(production).map((h) => [h.key, h.value]));

describe("TC-SEC-HDR-001 security headers", () => {
  it("forbid framing, plugins, base rewriting and foreign form targets in every environment", () => {
    for (const production of [true, false]) {
      const h = asMap(production);
      expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(h["Content-Security-Policy"]).toContain("object-src 'none'");
      expect(h["Content-Security-Policy"]).toContain("base-uri 'self'");
      expect(h["Content-Security-Policy"]).toContain("form-action 'self'");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Permissions-Policy"]).toContain("camera=()");
    }
  });

  it("send HSTS and upgrade insecure requests only in production, so localhost keeps working", () => {
    expect(asMap(true)["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(asMap(true)["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(asMap(false)["Strict-Transport-Security"]).toBeUndefined();
    expect(asMap(false)["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
  });
});
