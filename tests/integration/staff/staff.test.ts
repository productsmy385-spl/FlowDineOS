import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrdersAction } from "@/app/restaurant/orders/actions";
import {
  changeStaffRoleAction,
  deactivateStaffAction,
  inviteStaffAction,
  listStaffAction,
  reactivateStaffAction,
  resendStaffInviteAction,
  revokeStaffInviteAction,
} from "@/app/restaurant/staff/actions";
import { testDb } from "../setup/db";
import { actorState } from "../helpers/actor-state";
import { asSeedUser, asUserId, invokeAction, seedOnce, seeded, SEED_TENANTS, staffEmail, tenantIdOf } from "../helpers/actors";
import { dataOf, errorOf, expectSameNotFound, RANDOM_UUID } from "../orders/helpers";
import { APP_URL, clerkCalls, clerkStub, json, resetClerkStub, startClerkStub, stopClerkStub } from "../platform/helpers";

vi.mock("@/lib/auth/clerk-admin", async (importOriginal) => {
  const { stubbedClerkAdminModule } = await import("../platform/helpers");
  return stubbedClerkAdminModule(await importOriginal());
});

// S1-P07-T004 — LD-STF-01 and SA-STF-01…06: hierarchy (security.md §3.1), last-TENANT_ADMIN protection, self-change,
// tenant isolation with 404 parity, Clerk-boundary compensation, and deactivation taking effect on the next request
// (the second half of TC-AUTH-014).
const db = testDb();
const A = () => tenantIdOf("A");

beforeAll(async () => {
  await seedOnce();
  await startClerkStub();
}, 120_000);
afterAll(stopClerkStub);
beforeEach(() => {
  resetClerkStub();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
});
afterEach(() => vi.unstubAllEnvs());

const membershipOf = (tenant: "A" | "B", role: string) => seeded(tenant, `membership:${role}`);
const newEmail = () => `hire.${randomUUID().slice(0, 8)}+clerk_test@example.com`;

/** Removes memberships (and users) created by a test, so every test starts from the seed. */
async function cleanup(emails: string[]): Promise<void> {
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  if (users.length === 0) return;
  const ids = users.map((u) => u.id);
  await db.userTenant.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

describe("LD-STF-01 staff list", () => {
  it("LD-STF-01 lists only this tenant's members with the roles the caller may assign", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const admin = dataOf(await invokeAction(listStaffAction, {}));
    const emails = admin.items.map((m) => m.email);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.includes("spice") || e.includes("+clerk_test"))).toBe(true);
    expect(await db.userTenant.count({ where: { tenantId: A(), status: { not: "INACTIVE" } } })).toBe(admin.items.length);
    expect(admin.assignableRoles).toEqual(expect.arrayContaining(["TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"]));
    // No Tenant B member leaks in.
    const bEmails = new Set((await db.userTenant.findMany({ where: { tenantId: tenantIdOf("B") }, select: { user: { select: { email: true } } } })).map((m) => m.user.email));
    expect(emails.filter((e) => bEmails.has(e))).toEqual([]);

    // A MANAGER may not assign or manage TENANT_ADMIN.
    await asSeedUser("A", "MANAGER");
    const manager = dataOf(await invokeAction(listStaffAction, {}));
    expect(manager.assignableRoles).not.toContain("TENANT_ADMIN");
    expect(manager.items.find((m) => m.role === "TENANT_ADMIN")?.canManage).toBe(false);
    expect(manager.items.find((m) => m.isSelf)?.canManage).toBe(false);
  });

  it("TC-RBAC-114 CASHIER, KITCHEN and WAITER cannot read staff", async () => {
    for (const role of ["CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(errorOf(await invokeAction(listStaffAction, {})).code, role).toBe("FORBIDDEN");
    }
  });
});

describe("SA-STF-01 invite staff", () => {
  it("TC-STAFF-002 a manager is invited through Clerk: INVITED, with an emailed one-time code, audited", async () => {
    const email = newEmail();
    try {
      const { userId } = await asSeedUser("A", "TENANT_ADMIN");
      const member = dataOf(await invokeAction(inviteStaffAction, { email, fullName: "New Manager", role: "MANAGER" }));
      expect(member).toMatchObject({ email: email.toLowerCase(), role: "MANAGER", status: "INVITED", fullName: "New Manager" });

      const row = await db.userTenant.findUniqueOrThrow({ where: { id: member.membershipId } });
      expect(row).toMatchObject({ tenantId: A(), role: "MANAGER", status: "INVITED" });
      expect(row.clerkInvitationId).toBeTruthy();
      expect(clerkCalls()).toContain("POST /v1/invitations");

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "staff.invited", resourceId: member.membershipId } });
      expect(audit).toMatchObject({ tenantId: A(), actorUserId: userId, actorRole: "TENANT_ADMIN" });
      expect(JSON.stringify(audit.afterState)).not.toContain(email); // PII is masked (SC-PII-03)
    } finally {
      await cleanup([email.toLowerCase()]);
    }
  });

  // The owner's requirement (2026-10-02): counter and kitchen staff get no email at all. They sign in only with the
  // password their administrator generates each day (ADR-019 section 1).
  it.each(["CASHIER", "KITCHEN", "WAITER"] as const)("TC-STAFF-007 a %s is added with no Clerk invitation and no email", async (role) => {
    const email = newEmail();
    try {
      const { userId } = await asSeedUser("A", "TENANT_ADMIN");
      const before = clerkCalls().length;
      const member = dataOf(await invokeAction(inviteStaffAction, { email, fullName: "New Hire", role }));

      // Nothing was sent: not a single call reached Clerk for this person.
      expect(clerkCalls().slice(before)).toEqual([]);
      // Live straight away, because there is no invitation for them to accept.
      expect(member).toMatchObject({ role, status: "ACTIVE" });
      const row = await db.userTenant.findUniqueOrThrow({ where: { id: member.membershipId } });
      expect(row.clerkInvitationId).toBeNull();
      expect(row.acceptedAt).not.toBeNull();

      // Recorded as added, not invited: no invitation was ever sent, and the trail should not claim one was.
      expect(await db.auditLog.count({ where: { action: "staff.invited", resourceId: member.membershipId } })).toBe(0);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "staff.added", resourceId: member.membershipId } });
      expect(audit).toMatchObject({ tenantId: A(), actorUserId: userId, actorRole: "TENANT_ADMIN" });
    } finally {
      await cleanup([email.toLowerCase()]);
    }
  });

  it("TC-RBAC-010 refuses a role above the inviter, an existing member, and rejects a tenantId in the body", async () => {
    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(inviteStaffAction, { email: newEmail(), role: "TENANT_ADMIN" })).code).toBe("ROLE_NOT_ASSIGNABLE");

    await asSeedUser("A", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(inviteStaffAction, { email: staffEmail(SEED_TENANTS.A, "CASHIER"), role: "WAITER" })).code).toBe("ALREADY_MEMBER");
    const withTenant = errorOf(await invokeAction(inviteStaffAction, { email: newEmail(), role: "WAITER", tenantId: tenantIdOf("B") } as never));
    expect(withTenant.code).toBe("VALIDATION_ERROR");
  });

  it("TC-STAFF-005 a Clerk failure leaves no membership behind", async () => {
    const email = newEmail();
    try {
      await asSeedUser("A", "TENANT_ADMIN");
      clerkStub.override = (req, res) => (req.method === "POST" && req.pathname === "/v1/invitations" ? json(res, 500, { errors: [{ code: "internal" }] }) : false);
      expect(errorOf(await invokeAction(inviteStaffAction, { email, role: "MANAGER" })).code).toBe("INVITATION_FAILED");
      expect(await db.user.findUnique({ where: { email: email.toLowerCase() } })).toBeNull();
    } finally {
      await cleanup([email.toLowerCase()]);
    }
  });

  it("TC-STAFF-008 a Clerk outage does not stop a restaurant adding counter staff, because they never touch Clerk", async () => {
    const email = newEmail();
    try {
      await asSeedUser("A", "TENANT_ADMIN");
      clerkStub.override = (req, res) => (req.method === "POST" && req.pathname === "/v1/invitations" ? json(res, 500, { errors: [{ code: "internal" }] }) : false);
      expect(dataOf(await invokeAction(inviteStaffAction, { email, role: "WAITER" }))).toMatchObject({ role: "WAITER", status: "ACTIVE" });
    } finally {
      await cleanup([email.toLowerCase()]);
    }
  });
});

describe("SA-STF-02 / SA-STF-03 resend and revoke an invitation", () => {
  it("TC-STAFF-003 resends with a fresh invitation and revokes a pending one; an active member cannot be revoked", async () => {
    const email = newEmail();
    try {
      await asSeedUser("A", "TENANT_ADMIN");
      // A manager: staff roles are never pending, because they are never invited (ADR-019 section 1).
      const member = dataOf(await invokeAction(inviteStaffAction, { email, role: "MANAGER" }));
      const first = (await db.userTenant.findUniqueOrThrow({ where: { id: member.membershipId } })).clerkInvitationId;

      const resent = dataOf(await invokeAction(resendStaffInviteAction, { membershipId: member.membershipId }));
      expect(resent.status).toBe("INVITED");
      expect((await db.userTenant.findUniqueOrThrow({ where: { id: member.membershipId } })).clerkInvitationId).not.toBe(first);

      const revoked = dataOf(await invokeAction(revokeStaffInviteAction, { membershipId: member.membershipId }));
      expect(revoked.status).toBe("INACTIVE");
      expect(clerkCalls().some((c) => c.startsWith("POST /v1/invitations/") && c.endsWith("/revoke"))).toBe(true);

      // An ACTIVE member is not a pending invitation.
      expect(errorOf(await invokeAction(revokeStaffInviteAction, { membershipId: membershipOf("A", "CASHIER") })).code).toBe("INVALID_STATUS");
    } finally {
      await cleanup([email.toLowerCase()]);
    }
  });
});

describe("SA-STF-04 change role (security.md §3.1)", () => {
  it("TC-RBAC-010 (endpoint) TENANT_ADMIN promotes a cashier; MANAGER cannot touch a TENANT_ADMIN; nobody changes their own role", async () => {
    const cashier = membershipOf("A", "CASHIER");
    try {
      await asSeedUser("A", "TENANT_ADMIN");
      expect(dataOf(await invokeAction(changeStaffRoleAction, { membershipId: cashier, role: "MANAGER" })).role).toBe("MANAGER");
      expect(await db.auditLog.count({ where: { action: "staff.role_changed", resourceId: cashier } })).toBe(1);

      await asSeedUser("A", "MANAGER");
      expect(errorOf(await invokeAction(changeStaffRoleAction, { membershipId: membershipOf("A", "TENANT_ADMIN"), role: "WAITER" })).code).toBe("ROLE_NOT_ASSIGNABLE");

      const admin = await asSeedUser("A", "TENANT_ADMIN");
      const own = await db.userTenant.findFirstOrThrow({ where: { tenantId: A(), userId: admin.userId } });
      expect(errorOf(await invokeAction(changeStaffRoleAction, { membershipId: own.id, role: "MANAGER" })).code).toBe("SELF_CHANGE_NOT_ALLOWED");
    } finally {
      await db.userTenant.update({ where: { id: cashier }, data: { role: "CASHIER" } });
    }
  });

  it("TC-RBAC-012 (endpoint) the last active TENANT_ADMIN cannot be demoted or deactivated", async () => {
    const admin = await asSeedUser("A", "TENANT_ADMIN");
    const own = await db.userTenant.findFirstOrThrow({ where: { tenantId: A(), userId: admin.userId } });
    const others = await db.userTenant.count({ where: { tenantId: A(), role: "TENANT_ADMIN", status: "ACTIVE", NOT: { id: own.id } } });
    expect(others, "the seed has exactly one TENANT_ADMIN").toBe(0);

    // A second admin demoting the first is allowed; with only one left, the rule bites.
    const second = await db.userTenant.findFirstOrThrow({ where: { tenantId: A(), role: "MANAGER", status: "ACTIVE" } });
    await db.userTenant.update({ where: { id: second.id }, data: { role: "TENANT_ADMIN" } });
    try {
      await asUserId(second.userId);
      expect(dataOf(await invokeAction(changeStaffRoleAction, { membershipId: own.id, role: "MANAGER" })).role).toBe("MANAGER");
      // Now `second` is the only admin: demoting and deactivating themselves is refused for different reasons.
      expect(errorOf(await invokeAction(changeStaffRoleAction, { membershipId: second.id, role: "MANAGER" })).code).toBe("SELF_CHANGE_NOT_ALLOWED");
      await asUserId(second.userId);
      const viaOther = errorOf(await invokeAction(deactivateStaffAction, { membershipId: second.id }));
      expect(viaOther.code).toBe("SELF_CHANGE_NOT_ALLOWED");
    } finally {
      await db.userTenant.update({ where: { id: own.id }, data: { role: "TENANT_ADMIN" } });
      await db.userTenant.update({ where: { id: second.id }, data: { role: "MANAGER" } });
    }
  });
});

describe("SA-STF-05 / SA-STF-06 deactivate and reactivate", () => {
  it("TC-STAFF-004 / TC-AUTH-014 (second half) a deactivated member is denied on the very next request, and any Clerk sessions are revoked", async () => {
    const waiter = membershipOf("A", "WAITER");
    const row = await db.userTenant.findUniqueOrThrow({ where: { id: waiter } });
    // A waiter added before 2026-10-02 was sent an emailed code and may still hold a Clerk account. Deactivating
    // them must revoke those sessions too, so give this one an account to prove it (ADR-019 section 1).
    const clerkUserId = `user_legacy_${row.userId.slice(0, 8)}`;
    await db.user.update({ where: { id: row.userId }, data: { clerkUserId } });
    clerkStub.sessions.set(clerkUserId, ["sess_1", "sess_2"]);
    // The waiter is on shift, signed in the only way a waiter can be: with today's password.
    await asSeedUser("A", "WAITER");
    expect(dataOf(await invokeAction(getOrdersAction, {}))).toHaveProperty("orders");
    const waiterCookies = new Map(actorState.cookies);
    try {
      await asSeedUser("A", "TENANT_ADMIN");
      const result = dataOf(await invokeAction(deactivateStaffAction, { membershipId: waiter }));
      expect(result).toMatchObject({ member: { status: "INACTIVE" } });
      expect(clerkCalls().filter((c) => c.endsWith("/revoke") && c.includes("/sessions/")).length).toBe(2);

      // The waiter's own shift is refused on its very next request: the session row is re-read every time, and a
      // deactivated membership is no longer eligible for one (ADR-019 section 4).
      actorState.cookies = new Map(waiterCookies);
      actorState.clerkUserId = null;
      expect(errorOf(await invokeAction(getOrdersAction, {})).code).toBe("UNAUTHENTICATED");

      await asSeedUser("A", "TENANT_ADMIN");
      expect(dataOf(await invokeAction(reactivateStaffAction, { membershipId: waiter })).status).toBe("ACTIVE");
      // Reactivated, they sign in again with a password and are back in.
      await asSeedUser("A", "WAITER");
      expect(dataOf(await invokeAction(getOrdersAction, {}))).toHaveProperty("orders");
    } finally {
      await db.userTenant.update({ where: { id: waiter }, data: { status: "ACTIVE", deactivatedAt: null } });
    }
  });
});

describe("TI-055 staff of another tenant are invisible", () => {
  it("a Tenant B membership id answers exactly like a random UUID", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const foreign = membershipOf("B", "CASHIER");
    const before = await db.userTenant.findUniqueOrThrow({ where: { id: foreign } });

    for (const call of [
      (id: string) => invokeAction(changeStaffRoleAction, { membershipId: id, role: "WAITER" }),
      (id: string) => invokeAction(deactivateStaffAction, { membershipId: id }),
      (id: string) => invokeAction(revokeStaffInviteAction, { membershipId: id }),
    ]) {
      expectSameNotFound(await call(foreign), await call(RANDOM_UUID));
    }
    expect(await db.userTenant.findUniqueOrThrow({ where: { id: foreign } })).toEqual(before);
  });
});
