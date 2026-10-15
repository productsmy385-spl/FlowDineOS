import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { assertSameOrigin, isAllowedConsoleOrigin } from "@/lib/http/same-origin";

describe("isAllowedConsoleOrigin & assertSameOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const makeReq = (url: string, headers: Record<string, string> = {}) => {
    return new NextRequest(url, { headers });
  };

  describe("isAllowedConsoleOrigin", () => {
    it("allows configured platform apex URL", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");
      const req = makeReq("https://flowdine.in/api/v1/media/uploads");
      expect(isAllowedConsoleOrigin("https://flowdine.in", req)).toBe(true);
    });

    it("allows valid tenant subdomain under root domain", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");
      const req = makeReq("https://akshayapatra.flowdine.in/api/v1/media/uploads", {
        host: "akshayapatra.flowdine.in",
        "x-forwarded-host": "akshayapatra.flowdine.in",
      });
      expect(isAllowedConsoleOrigin("https://akshayapatra.flowdine.in", req)).toBe(true);
    });

    it("allows development localhost origins and tenant subdomains", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "");
      const req = makeReq("http://localhost:3000/api/v1/media/uploads");
      expect(isAllowedConsoleOrigin("http://localhost:3000", req)).toBe(true);

      const tenantReq = makeReq("http://akshayapatra.localhost:3000/api/v1/media/uploads", {
        host: "akshayapatra.localhost:3000",
      });
      expect(isAllowedConsoleOrigin("http://akshayapatra.localhost:3000", tenantReq)).toBe(true);
    });

    it("rejects foreign origins (e.g. evil.example)", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");
      const req = makeReq("https://flowdine.in/api/v1/media/uploads");
      expect(isAllowedConsoleOrigin("https://evil.example", req)).toBe(false);
      expect(isAllowedConsoleOrigin("https://attacker-site.com", req)).toBe(false);
      expect(isAllowedConsoleOrigin("https://flowdine.in.evil.com", req)).toBe(false);
    });

    it("rejects non-https in production for public domains", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");
      const req = makeReq("https://flowdine.in/api/v1/media/uploads");
      expect(isAllowedConsoleOrigin("http://akshayapatra.flowdine.in", req)).toBe(false);
    });
  });

  describe("assertSameOrigin", () => {
    it("passes when request is same-origin or same-site from an allowed console origin", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");

      const reqTenant = makeReq("https://akshayapatra.flowdine.in/api/v1/media/uploads", {
        origin: "https://akshayapatra.flowdine.in",
        "sec-fetch-site": "same-origin",
        host: "akshayapatra.flowdine.in",
      });
      expect(() => assertSameOrigin(reqTenant, "req-1")).not.toThrow();

      const reqSameSite = makeReq("https://flowdine.in/api/v1/media/uploads", {
        origin: "https://akshayapatra.flowdine.in",
        "sec-fetch-site": "same-site",
        host: "flowdine.in",
      });
      expect(() => assertSameOrigin(reqSameSite, "req-2")).not.toThrow();
    });

    it("throws ForbiddenError when Sec-Fetch-Site is cross-site", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");

      const req = makeReq("https://flowdine.in/api/v1/media/uploads", {
        origin: "https://flowdine.in",
        "sec-fetch-site": "cross-site",
      });
      expect(() => assertSameOrigin(req, "req-cross")).toThrow(ForbiddenError);
    });

    it("throws ForbiddenError when Origin header is missing", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");

      const req = makeReq("https://flowdine.in/api/v1/media/uploads", {
        "sec-fetch-site": "same-origin",
      });
      expect(() => assertSameOrigin(req, "req-missing")).toThrow(ForbiddenError);
    });

    it("throws ForbiddenError when Origin is foreign", () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://flowdine.in");
      vi.stubEnv("PUBLIC_ROOT_DOMAIN", "flowdine.in");

      const req = makeReq("https://flowdine.in/api/v1/media/uploads", {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      });
      expect(() => assertSameOrigin(req, "req-foreign")).toThrow(ForbiddenError);
    });
  });
});
