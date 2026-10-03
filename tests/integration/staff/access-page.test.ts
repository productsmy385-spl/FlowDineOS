import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import StaffAccessPage from "@/app/restaurant/staff/access/page";
import {
  generateStaffPasswordAction,
  listStaffAccessAction,
} from "@/app/restaurant/staff/actions";
import { StaffAccessBoard } from "@/components/staff/staff-access-board";
import { staffLogin } from "@/lib/services/staff-auth";
import { requireComponent } from "../menu/ui-tree";
import { testDb } from "../setup/db";
import {
  asSeedUser,
  invokeAction,
  invokeLoader,
  seedOnce,
  seeded,
} from "../helpers/actors";

/**
 * TC-STAFF-120…122 — the administrator's daily-password and attendance page (RASOIOS-ADR-019; C12, C13, C16).
 *
 * The page guard resolves `staff:read`, which a MANAGER also holds, so the loader's own administrator check is what
 * actually protects this. That is the property worth a test.
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

describe("TC-STAFF-120 who may open it", () => {
  it("an administrator gets the board, with every staff member listed", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const page = await invokeLoader(StaffAccessPage);
    const props = requireComponent(page, StaffAccessBoard, "StaffAccessBoard");

    expect(props.standing.length).toBeGreaterThan(0);
    // Only roles a daily password applies to — never an administrator or manager (C1).
    expect(
      props.standing.every((row) =>
        ["CASHIER", "KITCHEN", "WAITER"].includes(row.role),
      ),
    ).toBe(true);
    expect(props.standing.some((row) => row.membershipId === CASHIER_A())).toBe(
      true,
    );
  });

  it("a MANAGER is refused, even though they hold staff:read", async () => {
    await asSeedUser("A", "MANAGER");
    expect(await invokeAction(listStaffAccessAction, {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("a CASHIER cannot see who is working or for how long", async () => {
    await asSeedUser("A", "CASHIER");
    expect(await invokeAction(listStaffAccessAction, {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});

describe("TC-STAFF-121 what the board is told", () => {
  it("shows no live password before one is generated, and its expiry afterwards", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const before = await invokeAction(listStaffAccessAction, {});
    if (!("ok" in before) || !before.ok) throw new Error("loader failed");
    expect(
      before.data.standing.find((r) => r.membershipId === CASHIER_A())
        ?.credentialExpiresAt,
    ).toBeNull();

    await invokeAction(generateStaffPasswordAction, {
      membershipId: CASHIER_A(),
    });

    const after = await invokeAction(listStaffAccessAction, {});
    if (!("ok" in after) || !after.ok) throw new Error("loader failed");
    const row = after.data.standing.find((r) => r.membershipId === CASHIER_A());
    // The restaurant is Asia/Kolkata, so the day ends at 18:30Z — not at UTC midnight (C4).
    expect(row?.credentialExpiresAt).toMatch(/T18:30:00/);
    expect(row?.activeSince).toBeNull();
  });

  it("never carries the password itself to the browser", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = await invokeAction(generateStaffPasswordAction, {
      membershipId: CASHIER_A(),
    });
    if (!("ok" in issued) || !issued.ok) throw new Error("could not issue");
    const password = (issued.data as { password: string }).password;

    const listed = await invokeAction(listStaffAccessAction, {});
    // The plaintext is returned once, by the action that creates it. The board's own data must never contain it.
    expect(JSON.stringify(listed)).not.toContain(password.replace("-", ""));
    expect(JSON.stringify(listed)).not.toContain(password);
    expect(JSON.stringify(listed)).not.toContain("scrypt$");
  });

  it("reports an open shift and the session behind it once somebody signs in", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = await invokeAction(generateStaffPasswordAction, {
      membershipId: CASHIER_A(),
    });
    if (!("ok" in issued) || !issued.ok) throw new Error("could not issue");

    const email = (
      await db.userTenant.findUniqueOrThrow({
        where: { id: CASHIER_A() },
        select: { user: { select: { email: true } } },
      })
    ).user.email;
    const signedIn = await staffLogin({
      email,
      password: (issued.data as { password: string }).password,
      requestId: "test-access-page",
      ipAddress: null,
      userAgent: null,
    });
    expect(signedIn.outcome).toBe("OK");

    await asSeedUser("A", "TENANT_ADMIN");
    const listed = await invokeAction(listStaffAccessAction, {});
    if (!("ok" in listed) || !listed.ok) throw new Error("loader failed");

    expect(
      listed.data.standing.find((r) => r.membershipId === CASHIER_A())
        ?.activeSince,
    ).not.toBeNull();
    const session = listed.data.sessions.find(
      (s) => s.membershipId === CASHIER_A(),
    );
    expect(session).toMatchObject({ open: true, endedAt: null });
  });
});

describe("TC-STAFF-122 tenant isolation", () => {
  it("another restaurant's administrator sees only their own staff and shifts", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    await invokeAction(generateStaffPasswordAction, {
      membershipId: CASHIER_A(),
    });

    await asSeedUser("B", "TENANT_ADMIN");
    const listed = await invokeAction(listStaffAccessAction, {});
    if (!("ok" in listed) || !listed.ok) throw new Error("loader failed");

    expect(
      listed.data.standing.some((row) => row.membershipId === CASHIER_A()),
    ).toBe(false);
    // Tenant A just had a credential issued; none of it may appear here.
    expect(
      listed.data.standing.every((row) => row.credentialExpiresAt === null),
    ).toBe(true);
  });
});
