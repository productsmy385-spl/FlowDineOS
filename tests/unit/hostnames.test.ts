import { describe, expect, it } from "vitest";
import {
  RESERVED_HOST_LABELS,
  TENANT_HOST_LABEL,
  UNRESOLVABLE_PUBLIC_PATH,
  apexAuthorityFor,
  hostPort,
  isApexOnlyPath,
  isHostNeutralPath,
  isReservedHostLabel,
  normalizeHost,
  normalizeRootDomain,
  publicRewritePath,
  publicSiteUrl,
  resolveHost,
  tenantHostFor,
} from "@/lib/tenancy/hostnames";
import { SLUG_PATTERN } from "@/lib/validation/core";
import { isReservedSlug } from "@/lib/validation/platform";

// TC-WEB-018 (host parsing half) — S1-P09-T011, RASOIOS-ADR-012. The integration half, which needs a real tenant,
// lives in tests/integration/website/host-resolution.test.ts.
const ROOT = "rasoios.com";

describe("the host label and the tenant slug are the same thing", () => {
  it("uses exactly the SLUG_PATTERN expression, so a valid slug is always a valid host label", () => {
    expect(TENANT_HOST_LABEL.source).toBe(SLUG_PATTERN.source);
    expect(TENANT_HOST_LABEL.flags).toBe(SLUG_PATTERN.flags);
  });

  it("shares one reserved list with tenant slug validation (ADR-012 §1/§4)", () => {
    for (const label of ["admin", "api", "www", "app", "static", "assets", "mail", "sign-in", "sign-up", "account", "r", "offline", "restaurant"]) {
      expect(isReservedHostLabel(label), label).toBe(true);
      expect(isReservedSlug(label), label).toBe(true);
    }
    expect(isReservedHostLabel("ADMIN")).toBe(true);
    expect(isReservedHostLabel("spice-route")).toBe(false);
    expect(isReservedSlug("spice-route")).toBe(false);
    // Every reserved label is lower-case and unique, so membership tests cannot silently miss one.
    expect(RESERVED_HOST_LABELS.every((l) => l === l.toLowerCase())).toBe(true);
    expect(new Set(RESERVED_HOST_LABELS).size).toBe(RESERVED_HOST_LABELS.length);
  });
});

describe("normalizeHost", () => {
  it.each([
    ["Spice-Route.RASOIOS.com", "spice-route.rasoios.com"],
    ["spice-route.localhost:3000", "spice-route.localhost"],
    ["rasoios.com.", "rasoios.com"],
    ["[::1]:3000", "[::1]"],
    ["localhost", "localhost"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("refuses anything that is not a host", () => {
    for (const bad of ["", "   ", "evil.test/path", "a b.test", "user@evil.test", "host\nname", "x\\y.test", "a.test?q=1"]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
  });

  it("reads the port back", () => {
    expect(hostPort("spice-route.localhost:3000")).toBe("3000");
    expect(hostPort("rasoios.com")).toBeNull();
    expect(hostPort("[::1]:8080")).toBe("8080");
  });
});

describe("normalizeRootDomain", () => {
  it("accepts a bare domain and tolerates a pasted URL or a leading dot", () => {
    expect(normalizeRootDomain("rasoios.com")).toBe("rasoios.com");
    expect(normalizeRootDomain("  RASOIOS.com  ")).toBe("rasoios.com");
    expect(normalizeRootDomain("https://rasoios.com/")).toBe("rasoios.com");
    expect(normalizeRootDomain(".rasoios.com.")).toBe("rasoios.com");
    expect(normalizeRootDomain("rasoios.com:3000")).toBe("rasoios.com");
  });

  it("is null when unset or unusable, so the app runs without it", () => {
    for (const bad of [undefined, null, "", "   ", "localhost", "127.0.0.1", "rasoios", "not a domain"]) {
      expect(normalizeRootDomain(bad), String(bad)).toBeNull();
    }
  });
});

describe("resolveHost with PUBLIC_ROOT_DOMAIN configured", () => {
  const resolve = (host: string) => resolveHost(host, ROOT);

  it("resolves a tenant sub-domain to its slug", () => {
    expect(resolve("spice-route.rasoios.com")).toEqual({ kind: "tenant", slug: "spice-route" });
    expect(resolve("Spice-Route.RASOIOS.com:443")).toEqual({ kind: "tenant", slug: "spice-route" });
  });

  it("keeps the apex, www and every reserved label on the console", () => {
    for (const host of ["rasoios.com", "www.rasoios.com", "app.rasoios.com", "admin.rasoios.com", "api.rasoios.com", "static.rasoios.com", "mail.rasoios.com"]) {
      expect(resolve(host), host).toEqual({ kind: "apex" });
    }
  });

  it("refuses malformed labels and multi-label sub-domains", () => {
    for (const host of ["ab.rasoios.com", "-nope.rasoios.com", "bad_slug.rasoios.com", "a.b.rasoios.com", `${"x".repeat(49)}.rasoios.com`]) {
      expect(resolve(host), host).toEqual({ kind: "invalid" });
    }
  });

  it("treats an unrelated host, an IP literal and a missing header as the apex host", () => {
    for (const host of ["rasoios-app.up.railway.app", "192.168.1.10", "[::1]", "127.0.0.1", "localhost", "localhost:3000"]) {
      expect(resolve(host), host).toEqual({ kind: "apex" });
    }
    expect(resolveHost(null, ROOT)).toEqual({ kind: "apex" });
    expect(resolveHost("evil.test/path", ROOT)).toEqual({ kind: "apex" });
  });
});

describe("resolveHost with PUBLIC_ROOT_DOMAIN unset", () => {
  it("still serves *.localhost tenants and never crashes", () => {
    expect(resolveHost("spice-route.localhost:3000", null)).toEqual({ kind: "tenant", slug: "spice-route" });
    expect(resolveHost("harbour-grill.localhost", null)).toEqual({ kind: "tenant", slug: "harbour-grill" });
    expect(resolveHost("admin.localhost", null)).toEqual({ kind: "apex" });
    expect(resolveHost("ab.localhost", null)).toEqual({ kind: "invalid" });
  });

  it("treats the would-be production hosts as the apex host, so the console keeps working", () => {
    expect(resolveHost("spice-route.rasoios.com", null)).toEqual({ kind: "apex" });
    expect(resolveHost("rasoios.com", null)).toEqual({ kind: "apex" });
  });
});

describe("redirect and rewrite targets", () => {
  it("strips the tenant label to reach the apex authority, keeping the port", () => {
    expect(apexAuthorityFor("spice-route.localhost:3000", null)).toBe("localhost:3000");
    expect(apexAuthorityFor("spice-route.localhost", null)).toBe("localhost");
    expect(apexAuthorityFor("spice-route.rasoios.com", ROOT)).toBe("rasoios.com");
    expect(apexAuthorityFor("spice-route.rasoios.com:8443", ROOT)).toBe("rasoios.com:8443");
    expect(apexAuthorityFor("spice-route.rasoios.com:8080", ROOT)).toBe("rasoios.com");
    expect(apexAuthorityFor("akshayapatra.flowdine.in:8080", "flowdine.in")).toBe("flowdine.in");
    expect(apexAuthorityFor("rasoios.com", ROOT)).toBeNull();
    expect(apexAuthorityFor("localhost:3000", null)).toBeNull();
  });

  it("sends console, platform, account, authentication and /r paths back to the apex host (§6)", () => {
    for (const path of ["/restaurant", "/restaurant/orders", "/admin", "/admin/tenants", "/account/no-access", "/sign-in", "/sign-up/verify", "/r/other-slug"]) {
      expect(isApexOnlyPath(path), path).toBe(true);
    }
    for (const path of ["/", "/menu", "/about", "/restaurants-nearby", "/rabbit"]) {
      expect(isApexOnlyPath(path), path).toBe(false);
    }
  });

  it("leaves APIs, framework assets and well-known files alone on every host", () => {
    for (const path of ["/api/health", "/api/v1/print-agent/jobs/claim", "/api/webhooks/clerk", "/_next/static/chunk.js", "/icons/icon.svg", "/favicon.ico", "/robots.txt", "/manifest.json", "/sw.js"]) {
      expect(isHostNeutralPath(path), path).toBe(true);
    }
    for (const path of ["/", "/menu", "/apidocs"]) {
      expect(isHostNeutralPath(path), path).toBe(false);
    }
  });

  it("rewrites a tenant host onto the public route", () => {
    expect(publicRewritePath("spice-route", "/")).toBe("/r/spice-route");
    expect(publicRewritePath("spice-route", "/menu")).toBe("/r/spice-route/menu");
    // The unresolvable target is itself an invalid slug, so it renders the ordinary public 404 (§7).
    expect(UNRESOLVABLE_PUBLIC_PATH.startsWith("/r/")).toBe(true);
    expect(SLUG_PATTERN.test(UNRESOLVABLE_PUBLIC_PATH.slice(3))).toBe(false);
  });
});

describe("canonical address", () => {
  it("is the sub-domain when a root domain is configured, and nothing when it is not (§2/§3)", () => {
    expect(tenantHostFor("spice-route", ROOT)).toBe("spice-route.rasoios.com");
    expect(publicSiteUrl("spice-route", ROOT)).toBe("https://spice-route.rasoios.com/");
    expect(publicSiteUrl("spice-route", null)).toBeNull();
    expect(publicSiteUrl("admin", ROOT)).toBeNull();
    expect(publicSiteUrl("ab", ROOT)).toBeNull();
  });
});
