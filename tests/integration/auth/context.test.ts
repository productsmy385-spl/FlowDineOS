import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTenantResolution } from "@/lib/auth/context";
import { requirePlatform, requirePlatformPage, requireTenant, requireTenantPage } from "@/lib/auth/guards";
import { switchActiveTenantAction } from "@/app/account/select-tenant/actions";
import SignInLanding from "@/app/sign-in/landing/page";
import { testDb } from "../setup/db";
import {
  activeMembershipCookie,
  asAnonymous,
  asPlatformAdmin,
  asSeedUser,
  asUninvited,
  invokeAction,
  invokeLoader,
  seedOnce,
  seeded,
  setActiveMembershipCookie,
  tenantIdOf,
} from "../helpers/actors";

// TC-TENANT-001, TC-TENANT-004, TC-TENANT-005, TC-AUTH-008 and platform/tenant separation (S1-P04-T001…T004).
const db = testDb();

beforeAll(seedOnce, 120_000);
beforeEach(async () => {
  // Undo per-test mutations of the shared seed.
  await db.tenant.updateMany({ data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null } });
  await db.userTenant.updateMany({ where: { id: seeded("A", "membership:MANAGER") }, data: { role: "MANAGER", status: "ACTIVE" } });
  await db.userTenant.deleteMany({ where: { id: seeded("B", "membership:extra-for-A-manager") } });
});

describe("TC-TENANT-001 the tenant comes from the membership row only", () => {
  it("resolves Tenant A for Tenant A's cashier with the role's permissions", async () => {
    await asSeedUser("A", "CASHIER");
    const ctx = await requireTenant("order:read");
    expect(ctx.tenantId).toBe(tenantIdOf("A"));
    expect(ctx.role).toBe("CASHIER");
    expect(ctx.restaurant).toMatchObject({ timezone: "Asia/Kolkata", currencyCode: "INR" });
    expect(ctx.permissions.has("payment:record")).toBe(true);
    expect(ctx.permissions.has("refund:create")).toBe(false);
  });

  it("ignores a cookie holding Tenant B's id, Tenant B's membership id, or garbage", async () => {
    await asSeedUser("A", "CASHIER");
    for (const hostile of [tenantIdOf("B"), seeded("B", "membership:CASHIER"), "not-a-uuid", "' OR 1=1 --"]) {
      setActiveMembershipCookie(hostile);
      expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("A"));
    }
  });

  it("denies a permission the role lacks before loading anything (403 FORBIDDEN)", async () => {
    await asSeedUser("A", "WAITER");
    await expect(requireTenant("menu:manage")).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(requireTenant("not:a:permission" as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps every non-member state to a typed error", async () => {
    asAnonymous();
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });
    asUninvited();
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "NO_ACTIVE_MEMBERSHIP", statusCode: 403 });
    await asSeedUser("A", "WAITER");
    await db.userTenant.update({ where: { id: seeded("A", "membership:WAITER") }, data: { status: "INACTIVE" } });
    try {
      // A waiter signs in only with a daily password. Once their membership is gone the shift itself ends, so the
      // next request is simply signed out rather than signed in to nothing (ADR-019 section 4).
      await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    } finally {
      await db.userTenant.update({ where: { id: seeded("A", "membership:WAITER") }, data: { status: "ACTIVE" } });
    }
  });
});

describe("TC-TENANT-005 fresh authorization data on every request", () => {
  it("applies a role change on the next request without signing in again", async () => {
    await asSeedUser("A", "MANAGER");
    expect((await requireTenant("menu:manage")).role).toBe("MANAGER");
    await db.userTenant.update({ where: { id: seeded("A", "membership:MANAGER") }, data: { role: "WAITER" } });
    // Moved onto a staff role, the same Clerk session can no longer reach that membership at all: waiters sign in
    // with a daily password (ADR-019 section 1). The change still lands on the very next request.
    await expect(requireTenant("menu:manage")).rejects.toMatchObject({ code: "NO_ACTIVE_MEMBERSHIP" });
  });

  it("TC-AUTH-008 blocks a suspended tenant immediately: 403 TENANT_SUSPENDED and the suspended page", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("A"));
    await db.tenant.update({ where: { id: tenantIdOf("A") }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "Test suspension" } });
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "TENANT_SUSPENDED", statusCode: 403 });
    expect(await invokeLoader(requireTenantPage, "order:read")).toEqual({ redirect: "/account/suspended" });
  });
});

describe("TC-TENANT-004 active tenant selection", () => {
  async function giveManagerASecondRestaurant() {
    await db.userTenant.create({
      // MANAGER, not a staff role: a Clerk session cannot reach a staff membership, so a second waiter job would not
      // give this person a second restaurant to choose between (ADR-019 section 1).
      data: { id: seeded("B", "membership:extra-for-A-manager"), tenantId: tenantIdOf("B"), userId: seeded("A", "user:MANAGER"), role: "MANAGER", status: "ACTIVE" },
    });
  }

  it("requires a choice when the user has several active restaurants", async () => {
    await giveManagerASecondRestaurant();
    await asSeedUser("A", "MANAGER");
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "TENANT_SELECTION_REQUIRED", statusCode: 409 });
    expect(await invokeLoader(requireTenantPage, "order:read")).toEqual({ redirect: "/account/select-tenant" });
  });

  it("ignores another user's membership id in the cookie and sends the user to selection", async () => {
    await giveManagerASecondRestaurant();
    await asSeedUser("A", "MANAGER");
    setActiveMembershipCookie(seeded("B", "membership:TENANT_ADMIN"));
    const resolution = await getTenantResolution();
    expect(resolution.outcome).toBe("SELECT_REQUIRED");
  });

  it("switching accepts only the caller's own membership ids", async () => {
    await giveManagerASecondRestaurant();
    await asSeedUser("A", "MANAGER");

    const foreign = await invokeAction(switchActiveTenantAction, { membershipId: seeded("B", "membership:TENANT_ADMIN") });
    expect(foreign).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(activeMembershipCookie()).toBeUndefined();

    const withTenantId = await invokeAction(switchActiveTenantAction, { membershipId: seeded("B", "membership:extra-for-A-manager"), tenantId: tenantIdOf("A") } as never);
    expect(withTenantId).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

    const own = await invokeAction(switchActiveTenantAction, { membershipId: seeded("B", "membership:extra-for-A-manager") });
    expect(own).toEqual({ redirect: "/restaurant/dashboard" });
    expect(activeMembershipCookie()).toBe(seeded("B", "membership:extra-for-A-manager"));

    const ctx = await requireTenant("order:read");
    expect(ctx.tenantId).toBe(tenantIdOf("B"));
    expect(ctx.role).toBe("MANAGER");
    expect(await db.auditLog.count({ where: { action: "session.tenant_switched", actorUserId: seeded("A", "user:MANAGER") } })).toBe(1);
  });
});

describe("platform and tenant permissions never mix", () => {
  it("SUPER_ADMIN gets a platform context and no tenant context", async () => {
    await asPlatformAdmin();
    const ctx = await requirePlatform("platform:tenant:read");
    expect(ctx.kind).toBe("platform");
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "NO_ACTIVE_MEMBERSHIP" });
  });

  it("a TENANT_ADMIN is forbidden from platform pages and actions", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    await expect(requirePlatform("platform:tenant:read")).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(await invokeLoader(requirePlatformPage, "platform:tenant:read")).toEqual({ redirect: "/account/forbidden" });
  });

  it("sends signed-out and uninvited visitors to the right pages", async () => {
    asAnonymous();
    expect(await invokeLoader(requireTenantPage, "order:read")).toEqual({ redirect: "/sign-in" });
    asUninvited();
    expect(await invokeLoader(requireTenantPage, "order:read")).toEqual({ redirect: "/account/no-access?reason=NO_ACCOUNT" });
  });
});

/**
 * The post-sign-in landing (S1-P03-T005). It must reach the page the role actually starts on in a single hop: when it
 * handed off to `/restaurant` to decide, every sign-in paid for an extra render before anything was drawn.
 */
describe("post-sign-in landing", () => {
  it("sends each role straight to its own page", async () => {
    await asPlatformAdmin();
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/admin" });

    await asSeedUser("A", "MANAGER");
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/restaurant/dashboard" });

    await asSeedUser("A", "KITCHEN");
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/restaurant/kitchen" });

    await asSeedUser("A", "WAITER");
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/restaurant/orders" });
  });

  it("sends a user who cannot open a console to the matching account page", async () => {
    asAnonymous();
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/sign-in" });

    asUninvited();
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/account/no-access?reason=NO_ACCOUNT" });

    await asSeedUser("A", "MANAGER");
    await db.tenant.update({ where: { id: tenantIdOf("A") }, data: { status: "SUSPENDED" } });
    expect(await invokeLoader(SignInLanding)).toEqual({ redirect: "/account/suspended" });
  });

  it("never lands on a page that would only redirect again", async () => {
    await asSeedUser("A", "MANAGER");
    const landing = await invokeLoader(SignInLanding);
    expect(landing).not.toEqual({ redirect: "/restaurant" });
  });
});
