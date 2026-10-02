import { randomUUID } from "node:crypto";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import StaffPage from "@/app/restaurant/staff/page";
import { inviteStaffAction } from "@/app/restaurant/staff/actions";
import { StaffBoard, type StaffBoardProps } from "@/components/staff/staff-board";
import { requireTenantPage } from "@/lib/auth/guards";
import type { StaffListItem } from "@/lib/services/staff";
import { testDb } from "../setup/db";
import { asSeedUser, asUninvited, asUserId, invokeAction, invokeLoader, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { dataOf } from "../orders/helpers";
import { APP_URL, resetClerkStub, startClerkStub, stopClerkStub } from "../platform/helpers";

vi.mock("@/lib/auth/clerk-admin", async (importOriginal) => {
  const { stubbedClerkAdminModule } = await import("../platform/helpers");
  return stubbedClerkAdminModule(await importOriginal());
});

/**
 * TC-STAFF-001 — the staff screen (S1-P07-T006). The page is a Server Component, so it is rendered through
 * `invokeLoader` and asserted on what it hands the board: which people, which roles the caller may assign and which
 * controls are offered. The invitation is then accepted the way a real one is — the invited person signs in, and the
 * session resolver links the identity and activates the membership (ADR-006 §2).
 */
const db = testDb();
const A = tenantIdOf("A");

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

/** The props of the first element of `type` in a rendered tree. */
function propsOf<P>(node: ReactNode, type: unknown): P | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf<P>(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element.props as P;
  return propsOf<P>(element.props.children, type);
}

async function board(): Promise<StaffBoardProps> {
  const page = await invokeLoader(StaffPage);
  expect(isValidElement(page)).toBe(true);
  return propsOf<StaffBoardProps>(page as ReactNode, StaffBoard)!;
}

const find = (members: StaffListItem[], email: string) => members.find((member) => member.email === email);

describe("TC-STAFF-001 the staff screen", () => {
  const invited = `hire.${randomUUID().slice(0, 8)}+clerk_test@example.com`;

  // The invited person is left in place: once they have signed in they own audit rows, and the trail is append-only
  // (ADR-006). Every test file reseeds in `beforeAll`, so nothing else sees them.

  it("gives TENANT_ADMIN the whole team, every assignable role and the invite control", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const props = await board();
    expect(props.assignableRoles).toEqual(expect.arrayContaining(["TENANT_ADMIN", "MANAGER", "CASHIER", "KITCHEN", "WAITER"]));
    expect(props.can).toEqual({ invite: true, updateRole: true, deactivate: true });
    expect(props.timezone).toBe("Asia/Kolkata");

    const emails = props.members.map((member) => member.email);
    expect(emails.length).toBe(await db.userTenant.count({ where: { tenantId: A, status: { not: "INACTIVE" } } }));
    // Nobody from the other restaurant, and the signed-in person is marked as themselves.
    expect(emails.some((email) => email.includes("harbour"))).toBe(false);
    expect(props.members.filter((member) => member.isSelf)).toHaveLength(1);
  });

  it("offers MANAGER only the roles a manager may assign, and never a control over an administrator", async () => {
    await asSeedUser("A", "MANAGER");
    const props = await board();
    expect(props.assignableRoles).toEqual(["CASHIER", "KITCHEN", "WAITER"]);
    expect(props.assignableRoles).not.toContain("TENANT_ADMIN");
    expect(props.assignableRoles).not.toContain("MANAGER");

    const admin = props.members.find((member) => member.role === "TENANT_ADMIN");
    expect(admin?.canManage).toBe(false);
    expect(props.members.find((member) => member.isSelf)?.canManage).toBe(false);
    expect(props.members.find((member) => member.role === "CASHIER")?.canManage).toBe(true);
  });

  it("refuses every role that cannot read staff", async () => {
    for (const role of ["CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(await invokeLoader(StaffPage), role).toEqual({ redirect: "/account/forbidden" });
    }
  });

  it("an invited manager appears as invited, then as active once they sign in", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(inviteStaffAction, { email: invited, fullName: "New Manager", role: "MANAGER" }));

    const afterInvite = await board();
    const pending = find(afterInvite.members, invited);
    expect(pending).toMatchObject({ status: "INVITED", role: "MANAGER", fullName: "New Manager" });
    expect(pending?.acceptedAt).toBeNull();

    // The invited person signs in for the first time: the session resolver links the identity and activates them.
    asUninvited(invited);
    await invokeLoader(() => requireTenantPage("order:read"));

    await asSeedUser("A", "TENANT_ADMIN");
    const afterAccept = find((await board()).members, invited);
    expect(afterAccept).toMatchObject({ status: "ACTIVE", role: "MANAGER" });
    expect(afterAccept?.acceptedAt).toBeTruthy();
  });

  it("an added cashier is active at once: there is no invitation for them to accept (ADR-019 section 1)", async () => {
    // A different person from the manager above: `invited` is left in place on purpose, so it is already a member.
    const added = `added.${randomUUID().slice(0, 8)}+clerk_test@example.com`;
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(inviteStaffAction, { email: added, fullName: "New Hire", role: "CASHIER" }));

    const member = find((await board()).members, added);
    expect(member).toMatchObject({ status: "ACTIVE", role: "CASHIER", fullName: "New Hire" });
    expect(member?.acceptedAt).toBeTruthy();
  });

  it("a cashier who somehow holds a Clerk account still cannot reach the console through it", async () => {
    // Staff invited before 2026-10-02 received an emailed code and may have used it. Signing in with Clerk must no
    // longer reach a staff-role membership: the daily password is the only way in (ADR-019 section 1).
    const cashierUser = seeded("A", "user:CASHIER");
    await asUserId(cashierUser);
    expect(await invokeLoader(() => requireTenantPage("order:read"))).toEqual({ redirect: "/account/no-access?reason=NO_ACTIVE_MEMBERSHIP" });
  });
});
