import "server-only";
import type { TenantRole } from "@prisma/client";
import { clerkAdmin, maskEmail } from "@/lib/auth/clerk-admin";
import type { TenantContext } from "@/lib/auth/context-types";
import {
  alreadyMemberError,
  blocksInvitation,
  changeMembershipRole,
  createInvitedMembership,
  deactivateMembership,
  findInviteCandidate,
  findMembership,
  listStaffMembers,
  reactivateMembership,
  recordInviteResent,
  recordInviteRevoked,
  type MembershipTarget,
  type StaffMemberDto,
} from "@/lib/data/staff";
import { AppError, ConflictError, ForbiddenError, RateLimitedError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { consume, type RateLimitPolicy } from "@/lib/security/rate-limit";
import { now } from "@/lib/time/clock";
import type { ChangeStaffRoleData, InviteStaffData, ListStaffData } from "@/lib/validation/staff";
import { assertCanAssignRole, assertCanManage, assertNotLastTenantAdmin, assertNotSelf, assignableRoles, canManageMembership } from "./staff-rules";
import { appUrl } from "@/lib/env";

/**
 * Staff management (S1-P07-T004; api.md LD-STF-01, SA-STF-01…06; security.md §3.3 rows 14–17; SC-RBAC-04/05,
 * SC-AUTH-08). Callers have passed `requireTenant(<staff permission>)`; the tenant is always `ctx.tenantId`.
 *
 * Rules (lib/services/staff-rules.ts), applied to every action against the membership as it is inside the write's
 * transaction: the caller may only assign roles they rank above (TENANT_ADMIN: any) and only manage members whose role
 * they could assign — otherwise 403 ROLE_NOT_ASSIGNABLE; nobody changes or deactivates their own membership (409
 * SELF_CHANGE_NOT_ALLOWED); the last ACTIVE TENANT_ADMIN is never demoted or deactivated (409 LAST_TENANT_ADMIN).
 *
 * Clerk (lib/auth/clerk-admin.ts contract): invitations are created *before* the dependent local commit and revoked
 * again if that commit fails, so no local invitation exists without a Clerk invitation and vice versa; an invitation
 * is revoked in Clerk *before* the membership is marked revoked, so a Clerk failure changes nothing locally; sessions
 * are revoked *after* a deactivation commits (access already ends on the next request, ADR-006 §4).
 */

/** SA-STF-01/02: 30 invitation emails per hour per tenant (api.md). Fails closed: no quota check, no email. */
export const STAFF_INVITE_RATE_LIMIT: RateLimitPolicy = { limit: 30, windowSec: 60 * 60, failOpen: false };
export const STAFF_INVITE_RATE_SCOPE = "staff.invite";

/** 403 ROLE_NOT_ASSIGNABLE (api.md SA-STF-01, SA-STF-04; ADV-005). */
export class RoleNotAssignableError extends AppError {
  constructor(message: string) {
    super(message, 403, "ROLE_NOT_ASSIGNABLE");
  }
}

/** Runs a staff-rules hierarchy check, reporting a refusal with the contract's ROLE_NOT_ASSIGNABLE code. */
function hierarchy(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof ForbiddenError) throw new RoleNotAssignableError(error.message);
    throw error;
  }
}

function invalidStatus(message: string): ConflictError {
  return new ConflictError(message, "INVALID_STATUS");
}

/**
 * Where the Clerk invitation email sends the person: this app's sign-up page, built from NEXT_PUBLIC_APP_URL (validated
 * at boot by lib/env.ts) — never from input. A missing value is a server misconfiguration (500), checked before Clerk.
 */
function signUpUrl(): string {
  const base = appUrl();
  if (!base || !/^https?:\/\/[^\s]+$/.test(base)) throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  return new URL("/sign-up", base).toString();
}

async function enforceInviteRateLimit(ctx: TenantContext): Promise<void> {
  const result = await consume(STAFF_INVITE_RATE_SCOPE, ctx.tenantId, STAFF_INVITE_RATE_LIMIT);
  if (!result.allowed) throw new RateLimitedError(result.retryAfterSec, "Too many invitations were sent from this restaurant in the last hour. Try again later.");
}

/** Compensation for a local failure after Clerk created an invitation. Never masks the original error. */
async function revokeOrphanedInvitation(ctx: TenantContext, invitationId: string): Promise<void> {
  try {
    await clerkAdmin().revokeInvitation(invitationId);
  } catch (error) {
    logger.error("staff.invitation_compensation_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, invitationId, error: error instanceof Error ? error.message : String(error) });
  }
}

// ─── LD-STF-01 ───

export type StaffListItem = StaffMemberDto & { canManage: boolean };
export type StaffList = { items: StaffListItem[]; assignableRoles: TenantRole[] };

/** `staff:read` — members of the caller's tenant only (TI-052), with the roles the caller may assign. */
export async function listStaff(ctx: TenantContext, filters: ListStaffData): Promise<StaffList> {
  const members = await listStaffMembers(ctx, filters);
  return {
    items: members.map((m) => ({ ...m, canManage: !m.isSelf && canManageMembership(ctx.role, m.role) })),
    assignableRoles: [...assignableRoles(ctx.role)],
  };
}

// ─── SA-STF-01…03 invitations (`staff:invite`) ───

/**
 * SA-STF-01 — USER (if new) + USER_TENANT; 409 ALREADY_MEMBER; 403 ROLE_NOT_ASSIGNABLE.
 *
 * Two paths, decided by the role (RASOIOS-ADR-019 §1):
 *
 * - CASHIER, KITCHEN and WAITER get **no Clerk invitation and no email**. They do not use the identity provider at
 *   all, so sending them a one-time code would be an email they must not act on and a second way into the console.
 *   Their membership is ACTIVE immediately — there is nothing to accept — and their administrator gives them a
 *   password each day from Staff → Daily passwords.
 * - Everyone else is invited exactly as before: a Clerk invitation, INVITED until they accept it.
 */
export async function inviteStaff(ctx: TenantContext, input: InviteStaffData): Promise<StaffMemberDto> {
  hierarchy(() => assertCanAssignRole(ctx, input.role));

  const candidate = await findInviteCandidate(ctx, input.email);
  if (candidate.membership && blocksInvitation(candidate.membership)) throw alreadyMemberError(candidate.membership);
  if (candidate.user && candidate.user.status !== "ACTIVE") {
    throw new ConflictError("This person's account is disabled. Contact the platform administrator.", "ACCOUNT_INACTIVE");
  }

  if (usesDailyPassword(input.role)) {
    const member = await createInvitedMembership(ctx, { email: input.email, fullName: input.fullName, role: input.role, clerkInvitationId: null, now: now() });
    logger.info("staff.added", { requestId: ctx.requestId, tenantId: ctx.tenantId, membershipId: member.membershipId, role: member.role, email: maskEmail(input.email) });
    return member;
  }

  const redirectUrl = signUpUrl();
  await enforceInviteRateLimit(ctx);
  const { invitationId } = await clerkAdmin().createInvitation(input.email, redirectUrl);
  let member: StaffMemberDto;
  try {
    member = await createInvitedMembership(ctx, { email: input.email, fullName: input.fullName, role: input.role, clerkInvitationId: invitationId, now: now() });
  } catch (error) {
    await revokeOrphanedInvitation(ctx, invitationId);
    throw error;
  }
  logger.info("staff.invited", { requestId: ctx.requestId, tenantId: ctx.tenantId, membershipId: member.membershipId, role: member.role, email: maskEmail(input.email) });
  return member;
}

/** Roles that sign in with a daily password instead of an emailed one-time code (ADR-019 §1). */
function usesDailyPassword(role: TenantRole): boolean {
  return role === "CASHIER" || role === "KITCHEN" || role === "WAITER";
}

/** Loads a membership and applies the checks shared by resend and revoke. */
async function pendingInvitation(ctx: TenantContext, membershipId: string): Promise<MembershipTarget> {
  const target = await findMembership(ctx, membershipId);
  hierarchy(() => assertCanManage(ctx, target.role));
  if (target.status !== "INVITED") throw invalidStatus("Only a pending invitation can be resent or revoked.");
  return target;
}

/** SA-STF-02 — sends a fresh Clerk invitation and retires the previous one (`staff.invite_resent`). */
export async function resendStaffInvite(ctx: TenantContext, membershipId: string): Promise<StaffMemberDto> {
  const target = await pendingInvitation(ctx, membershipId);
  const redirectUrl = signUpUrl();
  await enforceInviteRateLimit(ctx);
  const { invitationId } = await clerkAdmin().createInvitation(target.email, redirectUrl);
  let member: StaffMemberDto;
  try {
    member = await recordInviteResent(ctx, target, invitationId, now());
  } catch (error) {
    if (invitationId !== target.clerkInvitationId) await revokeOrphanedInvitation(ctx, invitationId);
    throw error;
  }
  if (target.clerkInvitationId && target.clerkInvitationId !== invitationId) {
    // The old link would still work (same email, same pending membership); retire it, but never fail the resend.
    await revokeOrphanedInvitation(ctx, target.clerkInvitationId);
  }
  return member;
}

/** SA-STF-03 — revokes the Clerk invitation first, then marks the membership INACTIVE (`staff.invite_revoked`). */
export async function revokeStaffInvite(ctx: TenantContext, membershipId: string): Promise<StaffMemberDto> {
  const target = await pendingInvitation(ctx, membershipId);
  if (target.clerkInvitationId) await clerkAdmin().revokeInvitation(target.clerkInvitationId);
  return recordInviteRevoked(ctx, target, now());
}

// ─── SA-STF-04 role (`staff:update_role`) ───

/** SA-STF-04 — current and new role both assignable by the caller; not self; last TENANT_ADMIN kept (`staff.role_changed`). */
export async function changeStaffRole(ctx: TenantContext, input: ChangeStaffRoleData): Promise<StaffMemberDto> {
  return changeMembershipRole(ctx, input.membershipId, input.role, async (tx, target) => {
    hierarchy(() => {
      assertCanManage(ctx, target.role);
      assertCanAssignRole(ctx, input.role);
    });
    assertNotSelf(ctx, target.userId);
    if (target.status === "ACTIVE") await assertNotLastTenantAdmin(tx, ctx.tenantId, target.id, { nextRole: input.role });
  });
}

// ─── SA-STF-05/06 deactivate, reactivate (`staff:deactivate`) ───

export type SessionRevocation = "REVOKED" | "NOT_NEEDED" | "FAILED";
export type DeactivateStaffResult = { member: StaffMemberDto; sessions: SessionRevocation };

/**
 * SA-STF-05 — ACTIVE → INACTIVE (`staff.deactivated`); the person loses access to this restaurant on their next request.
 * If they have no other ACTIVE membership, their Clerk sessions are revoked after the commit (SC-AUTH-08). A platform
 * SUPER_ADMIN keeps their sessions (they still have platform access). A revocation failure does not undo the
 * deactivation — it is reported as `sessions: "FAILED"` and logged; the membership check already denies access.
 */
export async function deactivateStaff(ctx: TenantContext, membershipId: string): Promise<DeactivateStaffResult> {
  const result = await deactivateMembership(
    ctx,
    membershipId,
    async (tx, target) => {
      hierarchy(() => assertCanManage(ctx, target.role));
      assertNotSelf(ctx, target.userId);
      if (target.status !== "ACTIVE") {
        throw invalidStatus(target.status === "INVITED" ? "This person hasn't accepted their invitation yet. Revoke the invitation instead." : "This person is already deactivated.");
      }
      await assertNotLastTenantAdmin(tx, ctx.tenantId, target.id, { deactivate: true });
    },
    now(),
  );

  let sessions: SessionRevocation = "NOT_NEEDED";
  if (result.otherActiveMemberships === 0 && result.clerkUserId && result.platformRole !== "SUPER_ADMIN") {
    try {
      await clerkAdmin().revokeUserSessions(result.clerkUserId);
      sessions = "REVOKED";
    } catch (error) {
      sessions = "FAILED";
      logger.error("staff.session_revoke_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, membershipId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { member: result.member, sessions };
}

/** SA-STF-06 — INACTIVE → ACTIVE for someone who had joined (`staff.reactivated`); a revoked invitation needs a new invite. */
export async function reactivateStaff(ctx: TenantContext, membershipId: string): Promise<StaffMemberDto> {
  return reactivateMembership(ctx, membershipId, async (_tx, target) => {
    hierarchy(() => assertCanManage(ctx, target.role));
    assertNotSelf(ctx, target.userId);
    if (target.status !== "INACTIVE") throw invalidStatus(target.status === "ACTIVE" ? "This person is already active." : "This person has a pending invitation.");
    if (target.acceptedAt === null) throw invalidStatus("This invitation was revoked before it was accepted. Send a new invitation instead.");
  });
}
