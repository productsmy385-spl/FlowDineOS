import { describe, expect, it } from "vitest";
import { applyPlatformDefaults, EnvValidationError, parseEnv } from "@/lib/env";

// TC-FOUND-003 — environment validation fails fast and never echoes values (S1-P01-T004).
const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://app:pw@localhost:5432/rasoios?schema=public",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZGV2LmxvY2FsJA",
  CLERK_SECRET_KEY: "sk_test_abcdef0123456789",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    parseEnv(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(EnvValidationError);
    return (e as EnvValidationError).problems;
  }
}

describe("TC-FOUND-003 environment validation", () => {
  it("accepts a valid development environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NEXT_PUBLIC_CLERK_SIGN_IN_URL).toBe("/sign-in");
    expect(env.TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("names missing variables", () => {
    const problems = problemsOf({ NODE_ENV: "development" });
    expect(problems).toEqual(
      expect.arrayContaining([
        "DATABASE_URL: is required",
        "CLERK_SECRET_KEY: is required",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: is required",
        "NEXT_PUBLIC_APP_URL: is required",
      ]),
    );
  });

  it("rejects placeholder Clerk keys (fail closed, BA-04)", () => {
    const problems = problemsOf({
      ...valid,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder_key",
      CLERK_SECRET_KEY: "sk_test_placeholder_key",
    });
    expect(problems).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: contains a placeholder value");
    expect(problems).toContain("CLERK_SECRET_KEY: contains a placeholder value");
  });

  it("rejects malformed values", () => {
    const problems = problemsOf({ ...valid, CLERK_SECRET_KEY: "not-a-key", DATABASE_URL: "mysql://x", NEXT_PUBLIC_APP_URL: "localhost" });
    expect(problems).toContain("CLERK_SECRET_KEY: must be a Clerk secret key (sk_test_… or sk_live_…)");
    expect(problems).toContain("DATABASE_URL: must be a postgresql:// URL");
    expect(problems).toContain("NEXT_PUBLIC_APP_URL: must be an absolute URL");
  });

  it("never includes secret values in error messages", () => {
    const secret = "sk_live_SUPERSECRETVALUE123";
    try {
      parseEnv({ ...valid, CLERK_SECRET_KEY: secret, NEXT_PUBLIC_APP_URL: "nope" });
    } catch (e) {
      expect((e as Error).message).not.toContain("SUPERSECRETVALUE123");
      return;
    }
    throw new Error("expected validation to fail");
  });

  it("rejects server secrets exposed with a NEXT_PUBLIC_ prefix", () => {
    const problems = problemsOf({ ...valid, NEXT_PUBLIC_CLERK_SECRET_KEY: "sk_test_leak", NEXT_PUBLIC_ANALYTICS_ID: "sk_test_x" });
    expect(problems).toContain("NEXT_PUBLIC_CLERK_SECRET_KEY: server secret must not use the NEXT_PUBLIC_ prefix");
    expect(problems).toContain("NEXT_PUBLIC_ANALYTICS_ID: server secret must not use the NEXT_PUBLIC_ prefix");
  });

  it("requires https and database TLS in production", () => {
    const problems = problemsOf({
      ...valid,
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "http://app.example-restaurant.test",
      DATABASE_URL: "postgresql://app:pw@db.host:5432/rasoios",
    });
    expect(problems).toContain("NEXT_PUBLIC_APP_URL: must use https in production");
    expect(problems).toContain("DATABASE_URL: must set sslmode=require in production");

    // Private-network addresses are still networks: no exemption.
    const lan = problemsOf({ ...valid, NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://192.168.1.20:3000", DATABASE_URL: "postgresql://app:pw@10.0.0.5:5432/rasoios" });
    expect(lan).toContain("NEXT_PUBLIC_APP_URL: must use https in production");
    expect(lan).toContain("DATABASE_URL: must set sslmode=require in production");

    // Loopback never crosses a network (CI end-to-end runs a production build on localhost).
    expect(problemsOf({ ...valid, NODE_ENV: "production" })).toEqual([]);
    expect(problemsOf({ ...valid, NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3100", DATABASE_URL: "postgresql://app:pw@127.0.0.1:5432/rasoios" })).toEqual([]);
    // A deployment with a remote database but a copied development app URL is refused at boot.
    expect(problemsOf({ ...valid, NODE_ENV: "production", DATABASE_URL: "postgresql://app:pw@db.host:5432/rasoios?sslmode=require" })).toContain(
      "NEXT_PUBLIC_APP_URL: must use https in production",
    );
    // A look-alike host is not loopback.
    expect(problemsOf({ ...valid, NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost.evil.test" })).toContain("NEXT_PUBLIC_APP_URL: must use https in production");

    expect(
      problemsOf({
        ...valid,
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://app.example-restaurant.test",
        DATABASE_URL: "postgresql://app:pw@db.host:5432/rasoios?sslmode=require",
      }),
    ).toEqual([]);
  });

  it("on Railway, a renamed *.up.railway.app domain replaces the stale one; a custom domain is kept (2026-10-07)", () => {
    const renamed: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: "https://rasoios-production.up.railway.app", RAILWAY_PUBLIC_DOMAIN: "flowdineos-production.up.railway.app" };
    applyPlatformDefaults(renamed);
    expect(renamed.NEXT_PUBLIC_APP_URL).toBe("https://flowdineos-production.up.railway.app");

    const same: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: "https://flowdineos-production.up.railway.app/", RAILWAY_PUBLIC_DOMAIN: "flowdineos-production.up.railway.app" };
    applyPlatformDefaults(same);
    expect(same.NEXT_PUBLIC_APP_URL).toBe("https://flowdineos-production.up.railway.app/");

    const custom: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: "https://app.flowdineos.com", RAILWAY_PUBLIC_DOMAIN: "flowdineos-production.up.railway.app" };
    applyPlatformDefaults(custom);
    expect(custom.NEXT_PUBLIC_APP_URL).toBe("https://app.flowdineos.com");
  });

  it("on Railway, derives NEXT_PUBLIC_APP_URL from RAILWAY_PUBLIC_DOMAIN unless it is set explicitly", () => {
    const railway: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: undefined, RAILWAY_PUBLIC_DOMAIN: "rasoios-production.up.railway.app" };
    applyPlatformDefaults(railway);
    expect(railway.NEXT_PUBLIC_APP_URL).toBe("https://rasoios-production.up.railway.app");
    expect(problemsOf({ ...railway, NODE_ENV: "production", DATABASE_URL: "postgresql://app:pw@postgres.railway.internal:5432/railway" })).toEqual([]);

    const explicit: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: "https://app.akshaypatra.test", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" };
    applyPlatformDefaults(explicit);
    expect(explicit.NEXT_PUBLIC_APP_URL).toBe("https://app.akshaypatra.test");

    const hostile: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: undefined, RAILWAY_PUBLIC_DOMAIN: "evil.test/@x" };
    applyPlatformDefaults(hostile);
    expect(hostile.NEXT_PUBLIC_APP_URL).toBeUndefined();

    const none: Record<string, string | undefined> = { ...valid, NEXT_PUBLIC_APP_URL: undefined };
    applyPlatformDefaults(none);
    expect(problemsOf(none)).toContain("NEXT_PUBLIC_APP_URL: is required");
  });

  it("on Railway, a copied localhost app URL is replaced and the public DB proxy gets sslmode=require", () => {
    const railway: Record<string, string | undefined> = {
      ...valid,
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://postgres:pw@shuttle.proxy.rlwy.net:40123/railway",
      RAILWAY_PUBLIC_DOMAIN: "rasoios-production.up.railway.app",
    };
    applyPlatformDefaults(railway);
    expect(railway.NEXT_PUBLIC_APP_URL).toBe("https://rasoios-production.up.railway.app");
    expect(railway.DATABASE_URL).toBe("postgresql://postgres:pw@shuttle.proxy.rlwy.net:40123/railway?sslmode=require");
    expect(problemsOf(railway)).toEqual([]);

    // Internal hosts, an explicit sslmode and a real app URL are left exactly as configured.
    const kept: Record<string, string | undefined> = {
      ...valid,
      NEXT_PUBLIC_APP_URL: "https://app.akshaypatra.test",
      DATABASE_URL: "postgresql://postgres:pw@postgres.railway.internal:5432/railway",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
    };
    const before = { ...kept };
    applyPlatformDefaults(kept);
    expect(kept).toEqual(before);
    const verify = { ...valid, DATABASE_URL: "postgresql://p:pw@a.proxy.rlwy.net:1/railway?sslmode=verify-full", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" };
    applyPlatformDefaults(verify);
    expect(verify.DATABASE_URL).toBe("postgresql://p:pw@a.proxy.rlwy.net:1/railway?sslmode=verify-full");

    // Off Railway nothing changes: the localhost URL is still refused against a remote database.
    const elsewhere: Record<string, string | undefined> = { ...valid, NODE_ENV: "production", DATABASE_URL: "postgresql://a:b@db.host:5432/x?sslmode=require" };
    applyPlatformDefaults(elsewhere);
    expect(problemsOf(elsewhere)).toContain("NEXT_PUBLIC_APP_URL: must use https in production");
  });

  it("appUrl() reads the live value, not a build-time copy", async () => {
    const { appUrl } = await import("@/lib/env");
    const previous = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.NEXT_PUBLIC_APP_URL = "https://runtime.example-restaurant.test";
      expect(appUrl()).toBe("https://runtime.example-restaurant.test");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = previous;
    }
  });

  it("validates optional webhook secret and image host list formats", () => {
    const problems = problemsOf({ ...valid, CLERK_WEBHOOK_SIGNING_SECRET: "abc", ALLOWED_IMAGE_HOSTS: "images.test,not a host" });
    expect(problems).toContain("CLERK_WEBHOOK_SIGNING_SECRET: must be a Svix signing secret (whsec_…)");
    expect(problems).toContain("ALLOWED_IMAGE_HOSTS: must be a comma-separated list of hostnames");
  });
});

describe("TC-AUTH-009 missing or placeholder Clerk keys stop the app at boot", () => {
  it.each([
    ["missing publishable key", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined }, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
    ["missing secret key", { CLERK_SECRET_KEY: undefined }, "CLERK_SECRET_KEY"],
    ["placeholder publishable key", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder_key" }, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
    ["placeholder secret key", { CLERK_SECRET_KEY: "sk_test_placeholder_key" }, "CLERK_SECRET_KEY"],
    ["secret key in the wrong variable", { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_test_abcdef0123456789" }, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  ])("%s", (_label, override, variable) => {
    const problems = problemsOf({ ...valid, ...override });
    expect(problems.some((p) => p.startsWith(`${variable}:`))).toBe(true);
  });
});
