import { describe, expect, it } from "vitest";
import { classifyRoute, ensureRequestId, gate, mustNotBeStored, presentsStaffSession } from "@/lib/auth/route-policy";

// TC-AUTH-003 / TC-AUTH-004 — the middleware's decision table (S1-P03-T002). The e2e suite exercises the real
// middleware (tests/e2e/auth-gate.spec.ts).
const rid = "req-12345678";

describe("classifyRoute", () => {
  it.each([
    ["/", "public"],
    ["/r/spice-route", "public"],
    ["/r/spice-route/menu", "public"],
    ["/sign-in", "public"],
    ["/sign-in/factor-one", "public"],
    ["/sign-up", "public"],
    ["/offline", "public"],
    ["/api/health", "public"],
    ["/api/ready", "public"],
    ["/manifest.json", "public"],
    ["/api/webhooks/clerk", "webhook"],
    ["/api/v1/print-agent/jobs/claim", "agent"],
    ["/api/v1/print-agent", "agent"],
    ["/api/v1/orders", "api"],
    ["/api/print-jobs/poll", "api"],
    ["/restaurant/orders", "page"],
    ["/admin", "page"],
    ["/account/no-access", "page"],
  ])("%s is %s", (pathname, kind) => {
    expect(classifyRoute(pathname)).toBe(kind);
  });

  // The post-sign-in landing answers differently for every user, so it is a page even though it lives under
  // `/sign-in`. When it counted as public its per-user redirect carried no `no-store`, and a browser could replay
  // the one it was given while signed out — straight back to `/sign-in`.
  it("treats the post-sign-in landing as a signed-in page, not a public route", () => {
    expect(classifyRoute("/sign-in/landing")).toBe("page");
    expect(mustNotBeStored("/sign-in/landing")).toBe(true);
    expect(gate("/sign-in/landing", "", true, rid)).toEqual({ action: "next" });
    expect(gate("/sign-in/landing", "", false, rid)).toEqual({
      action: "redirect",
      location: "/sign-in?redirect_url=%2Fsign-in%2Flanding",
    });
  });

  it("keeps the sign-in form itself public", () => {
    expect(mustNotBeStored("/sign-in")).toBe(false);
    // Clerk owns the rest of /sign-in/* (factor-one, sso-callback, …) and those pages are the same for everyone.
    expect(classifyRoute("/sign-in/landings")).toBe("public");
  });

  it("does not treat look-alike paths as public", () => {
    expect(classifyRoute("/sign-inx")).toBe("page");
    expect(classifyRoute("/r")).toBe("page");
    expect(classifyRoute("/api/healthz")).toBe("api");
    expect(classifyRoute("/api/webhooks/clerk/extra")).toBe("api");
    expect(classifyRoute("/api/v1/print-agentx")).toBe("api");
  });
});

describe("gate", () => {
  it("TC-AUTH-003 redirects a signed-out page request to sign-in with a relative redirect_url", () => {
    expect(gate("/restaurant/orders", "", false, rid)).toEqual({ action: "redirect", location: "/sign-in?redirect_url=%2Frestaurant%2Forders" });
    expect(gate("/restaurant/orders", "?status=NEW", false, rid)).toEqual({
      action: "redirect",
      location: "/sign-in?redirect_url=%2Frestaurant%2Forders%3Fstatus%3DNEW",
    });
  });

  it("TC-AUTH-004 answers a signed-out API request with 401 UNAUTHENTICATED JSON", () => {
    expect(gate("/api/v1/orders", "", false, rid)).toEqual({
      action: "json",
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Sign in to continue.", requestId: rid } },
    });
  });

  it("lets public, agent and webhook routes through without a session (they authenticate themselves)", () => {
    for (const path of ["/", "/r/spice-route", "/sign-in", "/api/webhooks/clerk", "/api/v1/print-agent/jobs/claim"]) {
      expect(gate(path, "", false, rid)).toEqual({ action: "next" });
    }
  });

  it("lets signed-in requests through (authorization happens in the handler)", () => {
    expect(gate("/restaurant/orders", "", true, rid)).toEqual({ action: "next" });
    expect(gate("/api/v1/orders", "", true, rid)).toEqual({ action: "next" });
  });
});

describe("ensureRequestId", () => {
  it("keeps a well-formed incoming id and replaces anything else", () => {
    const generate = () => "generated-uuid";
    expect(ensureRequestId("abc12345-railway", generate)).toBe("abc12345-railway");
    expect(ensureRequestId(null, generate)).toBe("generated-uuid");
    expect(ensureRequestId("short", generate)).toBe("generated-uuid");
    expect(ensureRequestId("bad id\r\ninjected: 1", generate)).toBe("generated-uuid");
    expect(ensureRequestId("x".repeat(65), generate)).toBe("generated-uuid");
  });
});

describe("TC-SEC-006 no shared cache holds one person's data (SC-PUB-02)", () => {
  it("marks every session- or token-authenticated path no-store", () => {
    for (const path of [
      "/restaurant/orders",
      "/restaurant/transactions",
      "/admin",
      "/admin/tenants/123",
      "/account/select-tenant",
      "/api/v1/orders",
      "/api/v1/print-jobs",
      "/api/v1/print-agent/jobs/claim",
    ]) {
      expect(mustNotBeStored(path), path).toBe(true);
    }
  });

  it("leaves public routes cacheable, so the restaurant sites keep their ISR window", () => {
    for (const path of ["/", "/r/spice-route", "/r/spice-route/daily", "/sign-in", "/robots.txt", "/sitemap.xml", "/api/health", "/api/ready"]) {
      expect(mustNotBeStored(path), path).toBe(false);
    }
  });
});

// RASOIOS-ADR-019: a staff member who has just signed in with today's password has no Clerk session. The gate used to
// know only Clerk, so it sent them straight back to /sign-in to type the password again, forever.

describe("staff daily-password sessions at the gate", () => {
  const token = "A".repeat(43);

  it("recognises a well-formed staff session cookie", () => {
    expect(presentsStaffSession(token)).toBe(true);
    expect(presentsStaffSession("abc_DEF-123".padEnd(43, "x"))).toBe(true);
  });

  it("rejects anything not shaped like one of our tokens, without a database round trip", () => {
    for (const value of [undefined, null, "", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)} `]) {
      expect(presentsStaffSession(value), String(value)).toBe(false);
    }
  });

  it("lets a staff session through to the console, where the page re-checks it against the database", () => {
    expect(gate("/restaurant", "", presentsStaffSession(token), rid)).toEqual({ action: "next" });
    expect(gate("/restaurant/orders", "", presentsStaffSession(token), rid)).toEqual({ action: "next" });
    expect(gate("/api/v1/kitchen/tickets", "", presentsStaffSession(token), rid)).toEqual({ action: "next" });
  });

  it("still turns away a request with neither kind of session", () => {
    expect(gate("/restaurant", "", presentsStaffSession(undefined), rid)).toEqual({
      action: "redirect",
      location: "/sign-in?redirect_url=%2Frestaurant",
    });
  });
});
