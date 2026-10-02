"use server";

import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { listStaffSessions, listStaffStanding } from "@/lib/data/staff-auth";
import { assertStaffAdmin, forceLogoutStaff, generateDailyPassword, revokeDailyPassword } from "@/lib/services/staff-auth";
import { addDays, businessDateFor, toIsoDate } from "@/lib/time/business-date";
import { now as nowInstant } from "@/lib/time/clock";
import {
  changeStaffRole,
  deactivateStaff,
  inviteStaff,
  listStaff,
  reactivateStaff,
  resendStaffInvite,
  revokeStaffInvite,
} from "@/lib/services/staff";
import { parseInput } from "@/lib/validation/core";
import {
  changeStaffRoleSchema,
  inviteStaffSchema,
  listStaffSchema,
  membershipIdSchema,
  staffAttendanceSchema,
  staffCredentialSchema,
  type ChangeStaffRoleInput,
  type InviteStaffInput,
  type ListStaffInput,
  type MembershipIdInput,
  type StaffAttendanceInput,
  type StaffCredentialInput,
} from "@/lib/validation/staff";

/**
 * Staff management (S1-P07-T004; api.md LD-STF-01, SA-STF-01…06; security.md §3.3 rows 14–17). The permission is
 * checked first; the staff member is always one of the session's tenant (another tenant's membership id → 404,
 * TI-055/TI-056; a `tenantId` in the body → 422, TI-057). Hierarchy, self-change and last-TENANT_ADMIN rules are
 * enforced by `lib/services/staff.ts` for every action.
 */

/** LD-STF-01 — `staff:read`: members (filter by status/role) and the roles the caller may assign. */
export const listStaffAction = action(async (input: ListStaffInput = {}) => {
  const ctx = await requireTenant("staff:read");
  const filters = parseInput(listStaffSchema, input);
  return listStaff(ctx, filters);
});

/** SA-STF-01 — `staff:invite`: `{ email, fullName?, role }`; 409 ALREADY_MEMBER, 403 ROLE_NOT_ASSIGNABLE, 429. */
export const inviteStaffAction = action(async (input: InviteStaffInput) => {
  const ctx = await requireTenant("staff:invite");
  const data = parseInput(inviteStaffSchema, input);
  return inviteStaff(ctx, data);
});

/** SA-STF-02 — `staff:invite`: `{ membershipId }` of a pending invitation. */
export const resendStaffInviteAction = action(async (input: MembershipIdInput) => {
  const ctx = await requireTenant("staff:invite");
  const { membershipId } = parseInput(membershipIdSchema, input);
  return resendStaffInvite(ctx, membershipId);
});

/** SA-STF-03 — `staff:invite`: `{ membershipId }` of a pending invitation. */
export const revokeStaffInviteAction = action(async (input: MembershipIdInput) => {
  const ctx = await requireTenant("staff:invite");
  const { membershipId } = parseInput(membershipIdSchema, input);
  return revokeStaffInvite(ctx, membershipId);
});

/** SA-STF-04 — `staff:update_role`: `{ membershipId, role }`; 403 ROLE_NOT_ASSIGNABLE, 409 LAST_TENANT_ADMIN. */
export const changeStaffRoleAction = action(async (input: ChangeStaffRoleInput) => {
  const ctx = await requireTenant("staff:update_role");
  const data = parseInput(changeStaffRoleSchema, input);
  return changeStaffRole(ctx, data);
});

/** SA-STF-05 — `staff:deactivate`: `{ membershipId }`; revokes Clerk sessions when it was the person's last membership. */
export const deactivateStaffAction = action(async (input: MembershipIdInput) => {
  const ctx = await requireTenant("staff:deactivate");
  const { membershipId } = parseInput(membershipIdSchema, input);
  return deactivateStaff(ctx, membershipId);
});

/** SA-STF-06 — `staff:deactivate`: `{ membershipId }`. */
export const reactivateStaffAction = action(async (input: MembershipIdInput) => {
  const ctx = await requireTenant("staff:deactivate");
  const { membershipId } = parseInput(membershipIdSchema, input);
  return reactivateStaff(ctx, membershipId);
});

/**
 * Staff daily-password administration (RASOIOS-ADR-019, SA-STAFFAUTH-01…03).
 *
 * TENANT_ADMIN only. `staff:read` is the coarse gate; `assertStaffAdmin` is what actually restricts these, because
 * MANAGER already holds every `staff:*` permission including `staff:invite`, and the client was explicit that
 * issuing passwords and forcing people out is not a manager capability (C17). Adding a new permission instead would
 * be the cleaner RBAC shape, but the role table grants MANAGER the staff group wholesale, so an explicit assert is
 * the honest way to say "administrator only" without quietly widening the group.
 */
export const generateStaffPasswordAction = action(async (input: StaffCredentialInput) => {
  const ctx = await requireTenant("staff:read");
  assertStaffAdmin(ctx);
  const { membershipId } = parseInput(staffCredentialSchema, input);
  // The plaintext is returned exactly once, here. It is never stored, never logged and never audited (C5).
  return generateDailyPassword(ctx, membershipId);
});

export const revokeStaffPasswordAction = action(async (input: StaffCredentialInput) => {
  const ctx = await requireTenant("staff:read");
  assertStaffAdmin(ctx);
  const { membershipId } = parseInput(staffCredentialSchema, input);
  await revokeDailyPassword(ctx, membershipId);
  return { revoked: true as const };
});

export const forceLogoutStaffAction = action(async (input: StaffCredentialInput) => {
  const ctx = await requireTenant("staff:read");
  assertStaffAdmin(ctx);
  const { membershipId } = parseInput(staffCredentialSchema, input);
  return forceLogoutStaff(ctx, membershipId);
});

/**
 * LD-STAFFAUTH-01 — who may sign in with a daily password, who is on shift, and the recent attendance (C12/C13).
 *
 * One read of the restaurant's own staff and a bounded window of their sessions. TENANT_ADMIN only, like the rest
 * of this group: knowing who is working and for how long is management information, not a staff-level view.
 */
export const listStaffAccessAction = action(async (input: StaffAttendanceInput = {}) => {
  const ctx = await requireTenant("staff:read");
  assertStaffAdmin(ctx);
  const { days } = parseInput(staffAttendanceSchema, input);

  const today = businessDateFor(nowInstant(), ctx.restaurant.timezone);
  const from = addDays(today, -(days - 1));
  const [standing, sessions] = await Promise.all([listStaffStanding(ctx), listStaffSessions(ctx, from, today)]);

  return {
    standing: standing.map((row) => ({
      membershipId: row.membershipId,
      name: row.fullName ?? row.email,
      email: row.email,
      role: row.role,
      credentialExpiresAt: row.credential?.expiresAt.toISOString() ?? null,
      credentialGeneratedAt: row.credential?.generatedAt.toISOString() ?? null,
      activeSince: row.activeSession?.loginAt.toISOString() ?? null,
    })),
    sessions: sessions.map((row) => ({
      sessionId: row.sessionId,
      membershipId: row.membershipId,
      name: row.fullName ?? "",
      role: row.role,
      businessDate: toIsoDate(row.businessDate),
      loginAt: row.loginAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      endReason: row.endReason,
      open: row.status === "ACTIVE",
    })),
    from: toIsoDate(from),
    to: toIsoDate(today),
  };
});
