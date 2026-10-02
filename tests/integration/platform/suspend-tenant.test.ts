import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reactivateTenantAction, suspendTenantAction } from "@/app/admin/actions";
import { requireTenant, requireTenantPage } from "@/lib/auth/guards";
import { getPublicRestaurant } from "@/lib/data/public-restaurant";
import { createMembership } from "../../factories";
import { testDb } from "../setup/db";
import { asPlatformAdmin, asSeedUser, asUserId, invokeAction, invokeLoader, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { RANDOM_UUID, dataOf, errorOf } from "../orders/helpers";
import { clerkCalls, clerkStub, json, resetClerkStub, startClerkStub, stopClerkStub, xminOf } from "./helpers";

vi.mock("@/lib/auth/clerk-admin", async (importOriginal) => {
  const { stubbedClerkAdminModule } = await import("./helpers");
  return stubbedClerkAdminModule(await importOriginal());
});

// TC-ADMIN-005 (SA-ADM-03, SA-ADM-04) — suspension needs a 10–500 character reason, staff are denied on their next
// request, reactivation restores access (S1-P06-T001; TC-AUTH-008 covers the resolver itself).
const db = testDb();
const REASON = "Licence renewal pending — contact accounts.";

beforeAll(async () => {
  await seedOnce();
  await startClerkStub();
}, 120_000);
afterAll(stopClerkStub);
beforeEach(async () => {
  resetClerkStub();
  await db.tenant.updateMany({ data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null } });
});

describe("TC-ADMIN-005 suspend and reactivate", () => {
  it("requires a reason of 10–500 characters (after trimming); nothing changes otherwise", async () => {
    await asPlatformAdmin();
    for (const reason of ["too short", "   123456789   ", "x".repeat(501), ""]) {
      const error = errorOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason }));
      expect(error, JSON.stringify(reason)).toMatchObject({ code: "VALIDATION_ERROR", fieldErrors: { reason: [expect.any(String)] } });
    }
    expect(errorOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B") } as never)).fieldErrors?.reason).toBeDefined();
    expect(await db.tenant.findUniqueOrThrow({ where: { id: tenantIdOf("B") } })).toMatchObject({ status: "ACTIVE", suspendedAt: null });
    expect(await db.auditLog.count({ where: { action: "tenant.suspended" } })).toBe(0);
    expect(clerkCalls()).toEqual([]);

    // Exactly 10 and exactly 500 characters are accepted.
    expect(dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason: "1234567890" })).status).toBe("SUSPENDED");
    dataOf(await invokeAction(reactivateTenantAction, { targetTenantId: tenantIdOf("B") }));
    expect(dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason: "y".repeat(500) })).status).toBe("SUSPENDED");
  });

  it("suspends with an audited reason; the tenant's staff are denied on their next request and the public site disappears", async () => {
    // Before: Tenant A's cashier works normally and the public site is live.
    await asSeedUser("A", "CASHIER");
    expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("A"));
    expect((await getPublicRestaurant("spice-route")).slug).toBe("spice-route");

    const { userId: superAdminId } = await asPlatformAdmin();
    const data = dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("A"), reason: `  ${REASON}  ` }));
    expect(data).toMatchObject({ tenantId: tenantIdOf("A"), status: "SUSPENDED" });

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantIdOf("A") } });
    expect(tenant).toMatchObject({ status: "SUSPENDED", suspensionReason: REASON });
    expect(tenant.suspendedAt?.toISOString()).toBe(data.suspendedAt);
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenantIdOf("A"), action: "tenant.suspended" } });
    expect(audit).toMatchObject({ actorUserId: superAdminId, actorRole: "SUPER_ADMIN", resourceType: "tenant", resourceId: tenantIdOf("A"), reason: REASON, beforeState: { status: "ACTIVE" } });
    expect(audit.afterState).toMatchObject({ status: "SUSPENDED", suspendedAt: data.suspendedAt });
    expect(await xminOf("audit_logs", audit.id)).toBe(await xminOf("tenants", tenantIdOf("A")));

    // Next request of every Tenant A role: refused (TENANT_SUSPENDED) or sent to the suspended page.
    for (const role of ["TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      await expect(requireTenant("restaurant:read"), role).rejects.toMatchObject({ code: "TENANT_SUSPENDED", statusCode: 403 });
      expect(await invokeLoader(requireTenantPage, "restaurant:read"), role).toEqual({ redirect: "/account/suspended" });
    }
    await expect(getPublicRestaurant("spice-route")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Tenant B is untouched.
    await asSeedUser("B", "CASHIER");
    expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("B"));

    // Suspending twice is a conflict.
    await asPlatformAdmin();
    expect(errorOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("A"), reason: REASON })).code).toBe("ALREADY_SUSPENDED");
    expect(await db.auditLog.count({ where: { tenantId: tenantIdOf("A"), action: "tenant.suspended" } })).toBe(1);
  });

  it("reactivation restores access, clears the suspension and is audited; reactivating an active tenant is a conflict", async () => {
    await asPlatformAdmin();
    dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason: REASON }));
    await asSeedUser("B", "MANAGER");
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });

    await asPlatformAdmin();
    expect(dataOf(await invokeAction(reactivateTenantAction, { targetTenantId: tenantIdOf("B") }))).toEqual({ tenantId: tenantIdOf("B"), status: "ACTIVE" });
    expect(await db.tenant.findUniqueOrThrow({ where: { id: tenantIdOf("B") } })).toMatchObject({ status: "ACTIVE", suspendedAt: null, suspensionReason: null });
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenantIdOf("B"), action: "tenant.reactivated" }, orderBy: { createdAt: "desc" } });
    expect(audit).toMatchObject({ actorRole: "SUPER_ADMIN", beforeState: { status: "SUSPENDED" }, afterState: { status: "ACTIVE" } });
    expect(await xminOf("audit_logs", audit.id)).toBe(await xminOf("tenants", tenantIdOf("B")));

    await asSeedUser("B", "MANAGER");
    expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("B"));

    await asPlatformAdmin();
    expect(errorOf(await invokeAction(reactivateTenantAction, { targetTenantId: tenantIdOf("B") })).code).toBe("NOT_SUSPENDED");
  });

  it("signs out, via Clerk, only members left without any usable restaurant", async () => {
    // Link Clerk identities for three Tenant B members; B's manager also works at Tenant A.
    const admin = await asSeedUser("B", "TENANT_ADMIN");
    // A cashier added before 2026-10-02 was sent an emailed code and may hold a Clerk account; suspension must sign
    // that out too. Today's cashiers have no Clerk identity at all (ADR-019 section 1).
    const cashier = await asUserId(seeded("B", "user:CASHIER"));
    const manager = await asSeedUser("B", "MANAGER");
    // MANAGER at A, not a staff role: only a non-staff job is something a Clerk session can still reach elsewhere.
    const extra = await createMembership(db, tenantIdOf("A"), seeded("B", "user:MANAGER"), "MANAGER");
    clerkStub.sessions.set(admin.clerkUserId, ["sess_admin_1", "sess_admin_2"]);
    clerkStub.sessions.set(cashier.clerkUserId, ["sess_cashier_1"]);
    clerkStub.sessions.set(manager.clerkUserId, ["sess_manager_1"]);

    try {
      await asPlatformAdmin();
      const data = dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason: REASON }));

      const listed = clerkStub.requests.filter((r) => r.method === "GET").map((r) => r.query.get("user_id"));
      expect(listed).toContain(admin.clerkUserId);
      expect(listed).toContain(cashier.clerkUserId);
      expect(listed).not.toContain(manager.clerkUserId);
      const revoked = clerkStub.requests.filter((r) => r.method === "POST").map((r) => r.pathname);
      expect(revoked).toEqual(expect.arrayContaining(["/v1/sessions/sess_admin_1/revoke", "/v1/sessions/sess_admin_2/revoke", "/v1/sessions/sess_cashier_1/revoke"]));
      expect(revoked).not.toContain("/v1/sessions/sess_manager_1/revoke");
      expect(data.sessions).toEqual({ usersSignedOut: listed.length, failures: 0 });

      // The manager can still work at Tenant A.
      await asSeedUser("B", "MANAGER");
      expect((await requireTenant("order:read")).tenantId).toBe(tenantIdOf("A"));
    } finally {
      await db.userTenant.delete({ where: { id: extra.id } });
    }
  });

  it("a Clerk failure while signing members out does not undo the suspension", async () => {
    const cashier = await asSeedUser("B", "CASHIER");
    clerkStub.sessions.set(cashier.clerkUserId, ["sess_cashier_9"]);
    clerkStub.override = (req, res) => req.pathname.startsWith("/v1/sessions") && json(res, 503, { errors: [{ code: "unavailable", message: "down" }] });

    await asPlatformAdmin();
    const data = dataOf(await invokeAction(suspendTenantAction, { targetTenantId: tenantIdOf("B"), reason: REASON }));
    expect(data.sessions.failures).toBeGreaterThan(0);
    expect(data.sessions.usersSignedOut).toBe(0);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantIdOf("B") } })).status).toBe("SUSPENDED");
    expect(await db.auditLog.count({ where: { tenantId: tenantIdOf("B"), action: "tenant.suspended", reason: REASON } })).toBeGreaterThan(0);
    await asSeedUser("B", "CASHIER");
    await expect(requireTenant("order:read")).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  it("an unknown tenant is NOT_FOUND for both operations", async () => {
    await asPlatformAdmin();
    expect(errorOf(await invokeAction(suspendTenantAction, { targetTenantId: RANDOM_UUID, reason: REASON })).code).toBe("NOT_FOUND");
    expect(errorOf(await invokeAction(reactivateTenantAction, { targetTenantId: RANDOM_UUID })).code).toBe("NOT_FOUND");
    expect(clerkCalls()).toEqual([]);
  });
});
