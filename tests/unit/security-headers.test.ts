import { describe, expect, it } from "vitest";
import { clerkFrontendApiFromKey, contentSecurityPolicy, newNonce } from "@/lib/http/content-security-policy";
import { securityHeaders } from "@/lib/http/security-headers";

// TC-SEC-HDR-001/002 — hardening headers on every response and a nonce-based Content-Security-Policy on every page
// (security hardening 2026-10-07).
const asMap = (production: boolean) => Object.fromEntries(securityHeaders(production).map((h) => [h.key, h.value]));
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("TC-SEC-HDR-001 security headers", () => {
  it("forbid framing and sniffing and limit browser features in every environment", () => {
    for (const production of [true, false]) {
      const h = asMap(production);
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Permissions-Policy"]).toContain("camera=()");
      expect(h["Content-Security-Policy"]).toBeUndefined(); // built per request in the middleware
    }
  });

  it("send HSTS only in production, so localhost keeps working", () => {
    expect(asMap(true)["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(asMap(false)["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("TC-SEC-HDR-002 Content-Security-Policy", () => {
  const nonce = newNonce();
  const prod = contentSecurityPolicy({ nonce, production: true, clerkFrontendApi: "clerk.flowdine.example" });
  const dev = contentSecurityPolicy({ nonce, production: false, clerkFrontendApi: null });

  it("runs only scripts carrying this request's nonce", () => {
    expect(directive(prod, "script-src")).toContain(`'nonce-${nonce}'`);
    expect(directive(prod, "script-src")).toContain("'strict-dynamic'");
    expect(directive(prod, "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'"); // React refresh in development only
  });

  it("forbids framing, plugins, base rewriting and foreign form targets", () => {
    expect(directive(prod, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(prod, "object-src")).toBe("object-src 'none'");
    expect(directive(prod, "base-uri")).toBe("base-uri 'self'");
    expect(directive(prod, "form-action")).toBe("form-action 'self'");
    expect(prod).toContain("upgrade-insecure-requests");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("lets the browser talk only to this site and Clerk", () => {
    expect(directive(prod, "connect-src")).toContain("https://clerk.flowdine.example");
    expect(directive(prod, "connect-src")).not.toMatch(/ https: | \*( |$)/);
  });

  it("a nonce is fresh every time and the Clerk host comes only from a well-formed key", () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(clerkFrontendApiFromKey(`pk_test_${btoa("clerk.flowdine.example$")}`)).toBe("clerk.flowdine.example");
    expect(clerkFrontendApiFromKey(`pk_live_${btoa("evil.example; script-src *$")}`)).toBeNull();
    expect(clerkFrontendApiFromKey(undefined)).toBeNull();
  });
});
