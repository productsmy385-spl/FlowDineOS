import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  forceLogoutStaffAction,
  generateStaffPasswordAction,
  revokeStaffPasswordAction,
} from "@/app/restaurant/staff/actions";
import { requireTenant } from "@/lib/auth/guards";
import { hashStaffSessionToken } from "@/lib/auth/staff-session-cookie";
import {
  currentStaffSession,
  staffLogin,
  staffSignOut,
} from "@/lib/services/staff-auth";
import { testDb } from "../setup/db";
import {
  asAnonymous,
  asSeedUser,
  invokeAction,
  seedOnce,
  seeded,
  tenantIdOf,
} from "../helpers/actors";

/**
 * TC-STAFF-101…120 — staff daily-password login, sessions and attendance (RASOIOS-ADR-019).
 *
 * The security properties are the point of this file: a password that only works today, only for staff roles, only
 * for its own restaurant, and a force logout that actually ends access rather than hiding a screen.
 */
const db = testDb();

beforeAll(seedOnce, 180_000);
beforeEach(async () => {
  // Only the rows these tests own. Test files can share a worker database, so a blanket deleteMany({}) here wiped
  // other files' staff sessions and rate-limit buckets mid-test (it broke TC-SEC-013 intermittently).
  await db.staffSession.deleteMany({ where: { membershipId: CASHIER_A() } });
  await db.staffCredential.deleteMany({ where: { membershipId: CASHIER_A() } });
  await db.rateLimitBucket.deleteMany({
    where: { bucketKey: { startsWith: "staff.login." } },
  });
});

const CASHIER_A = () => seeded("A", "membership:CASHIER");
const login = (email: string, password: string) =>
  staffLogin({
    email,
    password,
    requestId: "test-staff-login",
    ipAddress: "203.0.113.9",
    userAgent: "vitest",
  });

/** Issue today's password for a membership, as its TENANT_ADMIN would. */
async function issue(membershipId: string): Promise<string> {
  await asSeedUser("A", "TENANT_ADMIN");
  const result = await invokeAction(generateStaffPasswordAction, {
    membershipId,
  });
  if (!("ok" in result) || !result.ok)
    throw new Error(`could not issue: ${JSON.stringify(result)}`);
  return (result.data as { password: string }).password;
}

async function emailOf(membershipId: string): Promise<string> {
  const row = await db.userTenant.findUniqueOrThrow({
    where: { id: membershipId },
    select: { user: { select: { email: true } } },
  });
  return row.user.email;
}

describe("TC-STAFF-101 generating today's password", () => {
  it("returns the password once and stores only a scrypt hash", async () => {
    const password = await issue(CASHIER_A());
    expect(password).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    const stored = await db.staffCredential.findFirstOrThrow({
      where: { membershipId: CASHIER_A() },
    });
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    // The plaintext must not be recoverable from the row in any form (C5).
    expect(stored.passwordHash).not.toContain(password);
    expect(stored.passwordHash).not.toContain(password.replace("-", ""));
    expect(JSON.stringify(stored)).not.toContain(password.replace("-", ""));
  });

  it("expires at the end of the restaurant's own business day, not UTC midnight", async () => {
    await issue(CASHIER_A());
    const stored = await db.staffCredential.findFirstOrThrow({
      where: { membershipId: CASHIER_A() },
    });
    // The seed restaurant is Asia/Kolkata (UTC+5:30), so its day ends at 18:30Z, never at 00:00Z (C4).
    expect(stored.expiresAt.toISOString()).toMatch(/T18:30:00/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("regenerating invalidates the previous password immediately", async () => {
    const first = await issue(CASHIER_A());
    const second = await issue(CASHIER_A());
    expect(second).not.toBe(first);

    const email = await emailOf(CASHIER_A());
    expect((await login(email, first)).outcome).toBe("INVALID");
    expect((await login(email, second)).outcome).toBe("OK");

    // The database itself allows only one live credential per membership, so this cannot drift (C14).
    expect(
      await db.staffCredential.count({
        where: { membershipId: CASHIER_A(), status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("refuses to issue one for a role that keeps its own sign-in", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    for (const role of ["TENANT_ADMIN", "MANAGER"] as const) {
      const result = await invokeAction(generateStaffPasswordAction, {
        membershipId: seeded("A", `membership:${role}`),
      });
      expect(result, role).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    }
  });
});

describe("TC-STAFF-102 who may administer staff passwords", () => {
  it("a MANAGER cannot generate, revoke or force logout — the client asked for administrator only", async () => {
    await asSeedUser("A", "MANAGER");
    const forbidden = { ok: false, error: { code: "FORBIDDEN" } };
    expect(
      await invokeAction(generateStaffPasswordAction, {
        membershipId: CASHIER_A(),
      }),
      "generate",
    ).toMatchObject(forbidden);
    expect(
      await invokeAction(revokeStaffPasswordAction, {
        membershipId: CASHIER_A(),
      }),
      "revoke",
    ).toMatchObject(forbidden);
    expect(
      await invokeAction(forceLogoutStaffAction, { membershipId: CASHIER_A() }),
      "force logout",
    ).toMatchObject(forbidden);
  });

  it("a CASHIER cannot generate a password for anyone, including themselves", async () => {
    await asSeedUser("A", "CASHIER");
    expect(
      await invokeAction(generateStaffPasswordAction, {
        membershipId: CASHIER_A(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("an administrator of another restaurant cannot touch this one's staff", async () => {
    await asSeedUser("B", "TENANT_ADMIN");
    expect(
      await invokeAction(generateStaffPasswordAction, {
        membershipId: CASHIER_A(),
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      await db.staffCredential.count({ where: { membershipId: CASHIER_A() } }),
    ).toBe(0);
  });
});

describe("TC-STAFF-103 signing in", () => {
  it("starts a shift and records when it began", async () => {
    const password = await issue(CASHIER_A());
    const result = await login(await emailOf(CASHIER_A()), password);
    expect(result.outcome).toBe("OK");
    if (result.outcome !== "OK") return;

    expect(result.session.tenantId).toBe(tenantIdOf("A"));
    expect(result.session.role).toBe("CASHIER");

    const session = await db.staffSession.findFirstOrThrow({
      where: { membershipId: CASHIER_A() },
    });
    expect(session.status).toBe("ACTIVE");
    expect(session.loginAt).toBeInstanceOf(Date);
    expect(session.endedAt).toBeNull();
    // Only the token's hash is stored, so a copy of this table cannot be replayed as a login.
    expect(session.tokenHash).toBe(hashStaffSessionToken(result.token));
    expect(session.tokenHash).not.toBe(result.token);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    await issue(CASHIER_A());
    expect((await login(await emailOf(CASHIER_A()), "WRNG-9999")).outcome).toBe(
      "INVALID",
    );
    expect((await login("nobody@example.test", "WRNG-9999")).outcome).toBe(
      "INVALID",
    );
  });

  it("refuses yesterday's password and says so, so staff know to ask for today's", async () => {
    const password = await issue(CASHIER_A());
    // Move the whole row back, not just its expiry: `staff_credentials_expires_after_creation_check` refuses a
    // credential that expired before it was created, which is the right refusal and makes this the right setup.
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    await db.staffCredential.updateMany({
      where: { membershipId: CASHIER_A() },
      data: { createdAt: past, expiresAt: new Date(past.getTime() + 60_000) },
    });
    expect((await login(await emailOf(CASHIER_A()), password)).outcome).toBe(
      "EXPIRED",
    );
    expect(
      await db.staffSession.count({ where: { membershipId: CASHIER_A() } }),
    ).toBe(0);
  });

  it("a revoked password stops working at once, and ends the shift it was holding open", async () => {
    const password = await issue(CASHIER_A());
    const first = await login(await emailOf(CASHIER_A()), password);
    expect(first.outcome).toBe("OK");

    await asSeedUser("A", "TENANT_ADMIN");
    expect(
      await invokeAction(revokeStaffPasswordAction, {
        membershipId: CASHIER_A(),
      }),
    ).toMatchObject({ ok: true });

    expect((await login(await emailOf(CASHIER_A()), password)).outcome).toBe(
      "INVALID",
    );
    const ended = await db.staffSession.findFirstOrThrow({
      where: { membershipId: CASHIER_A() },
    });
    expect(ended.status).toBe("ENDED");
    expect(ended.endReason).toBe("CREDENTIAL_REVOKED");
  });

  it("a password never opens another restaurant, even one whose staff share an email domain", async () => {
    const password = await issue(CASHIER_A());
    const result = await login(await emailOf(CASHIER_A()), password);
    expect(result.outcome).toBe("OK");
    if (result.outcome !== "OK") return;
    expect(result.session.tenantId).toBe(tenantIdOf("A"));
    expect(result.session.tenantId).not.toBe(tenantIdOf("B"));
    // The session this sign-in opened is Tenant A's; nothing for this person exists anywhere in Tenant B.
    expect(
      await db.staffSession.count({
        where: { tenantId: tenantIdOf("B"), membershipId: CASHIER_A() },
      }),
    ).toBe(0);
    expect(
      await db.staffSession.count({
        where: {
          tenantId: tenantIdOf("A"),
          membershipId: CASHIER_A(),
          status: "ACTIVE",
        },
      }),
    ).toBe(1);
  });
});

describe("TC-STAFF-104 force logout ends access, not just the view", () => {
  it("the session stops resolving on the very next request", async () => {
    const password = await issue(CASHIER_A());
    const signedIn = await login(await emailOf(CASHIER_A()), password);
    expect(signedIn.outcome).toBe("OK");
    if (signedIn.outcome !== "OK") return;

    // Still good before the administrator acts.
    expect(await currentStaffSession(signedIn.token)).not.toBeNull();

    await asSeedUser("A", "TENANT_ADMIN");
    expect(
      await invokeAction(forceLogoutStaffAction, { membershipId: CASHIER_A() }),
    ).toMatchObject({ ok: true, data: { ended: 1 } });

    // The token is unchanged and the cookie would still be sent — the server is what refuses it (C10).
    expect(await currentStaffSession(signedIn.token)).toBeNull();

    const row = await db.staffSession.findFirstOrThrow({
      where: { membershipId: CASHIER_A() },
    });
    expect(row.status).toBe("ENDED");
    expect(row.endReason).toBe("ADMIN_FORCE_LOGOUT");
    expect(row.endedByUserId).toBe(seeded("A", "user:TENANT_ADMIN"));
  });

  it("says plainly when there is nobody signed in to log out", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect(
      await invokeAction(forceLogoutStaffAction, { membershipId: CASHIER_A() }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("TC-STAFF-105 attendance", () => {
  it("records a full shift, and a second shift is its own record", async () => {
    const password = await issue(CASHIER_A());
    const email = await emailOf(CASHIER_A());

    const first = await login(email, password);
    if (first.outcome !== "OK") throw new Error("first login failed");
    await staffSignOut(first.token, "test-signout");

    const second = await login(email, password);
    if (second.outcome !== "OK") throw new Error("second login failed");

    const sessions = await db.staffSession.findMany({
      where: { membershipId: CASHIER_A() },
      orderBy: { loginAt: "asc" },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      status: "ENDED",
      endReason: "SIGNED_OUT",
    });
    expect(sessions[0].endedAt).not.toBeNull();
    expect(sessions[1].status).toBe("ACTIVE");
    // Duration comes from the session rows themselves, never from a date change (C9).
    expect(sessions[0].endedAt!.getTime()).toBeGreaterThanOrEqual(
      sessions[0].loginAt.getTime(),
    );
  });

  it("signing in again moves the shift rather than forking it", async () => {
    const password = await issue(CASHIER_A());
    const email = await emailOf(CASHIER_A());
    const first = await login(email, password);
    const second = await login(email, password);
    expect(first.outcome).toBe("OK");
    expect(second.outcome).toBe("OK");

    // The partial unique index allows exactly one open shift per membership.
    expect(
      await db.staffSession.count({
        where: { membershipId: CASHIER_A(), status: "ACTIVE" },
      }),
    ).toBe(1);
    if (first.outcome === "OK")
      expect(await currentStaffSession(first.token)).toBeNull();
  });
});

describe("TC-STAFF-106 the Clerk path is untouched", () => {
  it("an administrator still resolves through Clerk with no staff session anywhere", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const ctx = await requireTenant("staff:read");
    expect(ctx.role).toBe("TENANT_ADMIN");
    expect(ctx.tenantId).toBe(tenantIdOf("A"));
    // Resolved through Clerk, not through any staff session: the administrator has none.
    const admin = seeded("A", "membership:TENANT_ADMIN");
    expect(
      await db.staffSession.count({ where: { membershipId: admin } }),
    ).toBe(0);
  });

  it("a signed-out visitor with no staff cookie is simply signed out", async () => {
    asAnonymous();
    expect(await currentStaffSession(null)).toBeNull();
    expect(await currentStaffSession("not-a-real-token")).toBeNull();
  });
});
