import "server-only";
import { Prisma, type MembershipStatus, type PlatformRole, type TenantRole, type UserStatus } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { ConflictError } from "@/lib/errors";
import type { ListStaffData } from "@/lib/validation/staff";
import { nullableInstantDto } from "./dto";
import { mapErrors } from "./errors";
import { notFoundOrConflict, required, tenantScope } from "./scope";
import { withTx, type Tx } from "./tx";

/**
 * Staff memberships of the caller's tenant (S1-P07-T004; data-model.md E05–E06; api.md LD-STF-01, SA-STF-01…06).
 *
 * USER is global identity; USER_TENANT is the tenant-owned authorization membership (never a subscription, ADR-002).
 * Every membership read and write is scoped to `ctx.tenantId`; another tenant's membership id is 404 exactly like a
 * missing one (TI-055, TI-056). Business rules (role hierarchy, self-change, last TENANT_ADMIN) are supplied by the
 * service as a `guard` that runs inside the same transaction as the write, against the freshly read membership.
 * Writes are guarded on the state the guard saw (`updateMany … where status/role`), so a concurrent change makes the
 * request fail with 409 instead of silently overwriting. Each change writes its `staff.*` audit row in the same
 * transaction (SC-AUD-02).
 */

export type StaffMemberDto = {
  membershipId: string;
  userId: string;
  fullName: string | null;
  email: string;
  role: TenantRole;
  status: MembershipStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  deactivatedAt: string | null;
  isSelf: boolean;
};

/** A membership as the service's rules need it (never returned to clients as is). */
export type MembershipTarget = {
  id: string;
  userId: string;
  role: TenantRole;
  status: MembershipStatus;
  acceptedAt: Date | null;
  clerkInvitationId: string | null;
  email: string;
  fullName: string | null;
  clerkUserId: string | null;
  userStatus: UserStatus;
  platformRole: PlatformRole;
};

export type MembershipGuard = (tx: Tx, target: MembershipTarget) => Promise<void>;

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  invitedAt: true,
  acceptedAt: true,
  deactivatedAt: true,
  clerkInvitationId: true,
  user: { select: { email: true, fullName: true, clerkUserId: true, status: true, platformRole: true } },
} satisfies Prisma.UserTenantSelect;
type MemberRow = Prisma.UserTenantGetPayload<{ select: typeof MEMBER_SELECT }>;

function toDto(ctx: TenantContext, row: MemberRow): StaffMemberDto {
  return {
    membershipId: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    role: row.role,
    status: row.status,
    invitedAt: nullableInstantDto(row.invitedAt),
    acceptedAt: nullableInstantDto(row.acceptedAt),
    deactivatedAt: nullableInstantDto(row.deactivatedAt),
    isSelf: row.userId === ctx.userId,
  };
}

function toTarget(row: MemberRow): MembershipTarget {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    acceptedAt: row.acceptedAt,
    clerkInvitationId: row.clerkInvitationId,
    email: row.user.email,
    fullName: row.user.fullName,
    clerkUserId: row.user.clerkUserId,
    userStatus: row.user.status,
    platformRole: row.user.platformRole,
  };
}

const STATUS_ORDER: Record<MembershipStatus, number> = { ACTIVE: 0, INVITED: 1, INACTIVE: 2 };

/** LD-STF-01 — the tenant's members, sorted by status (active, invited, inactive) then name. */
export async function listStaffMembers(ctx: TenantContext, filters: ListStaffData): Promise<StaffMemberDto[]> {
  const rows = await mapErrors("Staff member", () =>
    db.userTenant.findMany({
      where: tenantScope(ctx, { ...(filters.status ? { status: filters.status } : {}), ...(filters.role ? { role: filters.role } : {}) }),
      select: MEMBER_SELECT,
      take: 200, // bounded read (SC-API-04); one restaurant's team is far smaller
    }),
  );
  const nameOf = (r: MemberRow) => (r.user.fullName ?? r.user.email).toLocaleLowerCase("en");
  return rows
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || nameOf(a).localeCompare(nameOf(b), "en") || a.id.localeCompare(b.id))
    .map((row) => toDto(ctx, row));
}

async function readTarget(client: Tx, ctx: TenantContext, membershipId: string): Promise<MemberRow> {
  return required(await client.userTenant.findFirst({ where: tenantScope(ctx, { id: membershipId }), select: MEMBER_SELECT }), "Staff member");
}

/** One membership of the caller's tenant (404 for a missing or another tenant's id). */
export async function findMembership(ctx: TenantContext, membershipId: string): Promise<MembershipTarget> {
  return toTarget(await mapErrors("Staff member", () => readTarget(db, ctx, membershipId)));
}

export type InviteCandidate = {
  user: { id: string; status: UserStatus } | null;
  membership: MembershipTarget | null;
};

/** The global USER for an (already normalised) email, and its membership in the caller's tenant if any. */
export async function findInviteCandidate(ctx: TenantContext, email: string): Promise<InviteCandidate> {
  return mapErrors("Staff member", async () => {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, status: true } });
    if (!user) return { user: null, membership: null };
    const membership = await db.userTenant.findFirst({ where: tenantScope(ctx, { userId: user.id }), select: MEMBER_SELECT });
    return { user, membership: membership ? toTarget(membership) : null };
  });
}

/** Whether an existing membership blocks a new invitation (ACTIVE, INVITED, or deactivated after being accepted). */
export function blocksInvitation(membership: Pick<MembershipTarget, "status" | "acceptedAt">): boolean {
  return membership.status !== "INACTIVE" || membership.acceptedAt !== null;
}

export function alreadyMemberError(membership: Pick<MembershipTarget, "status">): ConflictError {
  return new ConflictError(
    membership.status === "INACTIVE"
      ? "This person is a deactivated member of this restaurant. Reactivate them instead of inviting them again."
      : membership.status === "INVITED"
        ? "This person already has a pending invitation. Resend it instead."
        : "This person is already a member of this restaurant.",
    "ALREADY_MEMBER",
  );
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * SA-STF-01 local part, after the Clerk invitation exists: USER (created when new), USER_TENANT INVITED with the
 * invitation id, `staff.invited` — one transaction. A revoked, never-accepted invitation is re-used (the membership
 * is unique per tenant and user). An existing membership that blocks invitations is 409 ALREADY_MEMBER.
 */
export async function createInvitedMembership(
  ctx: TenantContext,
  input: { email: string; fullName: string | null; role: TenantRole; clerkInvitationId: string | null; now: Date },
): Promise<StaffMemberDto> {
  return withTx(ctx, async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { email: input.email }, select: { id: true, fullName: true } });
    const user = existingUser
      ? existingUser.fullName === null && input.fullName
        ? await tx.user.update({ where: { id: existingUser.id }, data: { fullName: input.fullName }, select: { id: true, fullName: true } })
        : existingUser
      : await tx.user.create({ data: { email: input.email, fullName: input.fullName }, select: { id: true, fullName: true } });

    const existing = await tx.userTenant.findFirst({ where: tenantScope(ctx, { userId: user.id }), select: MEMBER_SELECT });
    if (existing && blocksInvitation(existing)) throw alreadyMemberError(existing);

    // Staff roles never receive a Clerk invitation, so there is nothing for them to accept: the membership is live
    // from the moment it is created, and their administrator issues them a daily password (ADR-019 §1). Everyone
    // else stays INVITED until they accept the emailed one-time code.
    const immediate = input.clerkInvitationId === null;
    const data = {
      role: input.role,
      status: immediate ? ("ACTIVE" as const) : ("INVITED" as const),
      invitedByUserId: ctx.userId,
      invitedAt: input.now,
      acceptedAt: immediate ? input.now : null,
      clerkInvitationId: input.clerkInvitationId,
      deactivatedAt: null,
      deactivatedByUserId: null,
    };
    let row: MemberRow;
    if (existing) {
      const updated = await tx.userTenant.updateMany({ where: tenantScope(ctx, { id: existing.id, status: "INACTIVE" as const, acceptedAt: null }), data });
      if (updated.count !== 1) throw new ConflictError("This membership was changed by someone else. Reload and try again.");
      row = await readTarget(tx, ctx, existing.id);
    } else {
      try {
        row = await tx.userTenant.create({ data: { tenantId: ctx.tenantId, userId: user.id, ...data }, select: MEMBER_SELECT });
      } catch (error) {
        // A concurrent invitation of the same person won the race.
        if (isUniqueViolation(error)) throw alreadyMemberError({ status: "INVITED" });
        throw error;
      }
    }

    await audit(tx, ctx, {
      action: immediate ? "staff.added" : "staff.invited",
      resourceType: "user_tenant",
      resourceId: row.id,
      before: existing ? { status: existing.status, role: existing.role } : null,
      after: { status: row.status, role: row.role, email: row.user.email, newUser: !existingUser },
    });
    return toDto(ctx, row);
  });
}

/** Guarded single-row membership update; 0 rows → 409 if the membership still exists here, else 404. */
async function guardedUpdate(
  tx: Tx,
  ctx: TenantContext,
  target: Pick<MembershipTarget, "id" | "status" | "role">,
  data: Prisma.UserTenantUncheckedUpdateManyInput,
): Promise<MemberRow> {
  const updated = await tx.userTenant.updateMany({ where: tenantScope(ctx, { id: target.id, status: target.status, role: target.role }), data });
  if (updated.count !== 1) {
    throw await notFoundOrConflict(async () => (await tx.userTenant.findFirst({ where: tenantScope(ctx, { id: target.id }), select: { id: true } })) !== null, "Staff member");
  }
  return readTarget(tx, ctx, target.id);
}

/** SA-STF-02 local part: the new Clerk invitation replaces the old one (`staff.invite_resent`). */
export async function recordInviteResent(ctx: TenantContext, target: MembershipTarget, clerkInvitationId: string, now: Date): Promise<StaffMemberDto> {
  return withTx(ctx, async (tx) => {
    const row = await guardedUpdate(tx, ctx, target, { clerkInvitationId, invitedAt: now });
    await audit(tx, ctx, {
      action: "staff.invite_resent",
      resourceType: "user_tenant",
      resourceId: row.id,
      before: { status: target.status, invitationReplaced: target.clerkInvitationId !== null },
      after: { status: row.status, invitedAt: now.toISOString() },
    });
    return toDto(ctx, row);
  });
}

/** SA-STF-03 local part: INVITED → INACTIVE after the Clerk invitation was revoked (`staff.invite_revoked`). */
export async function recordInviteRevoked(ctx: TenantContext, target: MembershipTarget, now: Date): Promise<StaffMemberDto> {
  return withTx(ctx, async (tx) => {
    const row = await guardedUpdate(tx, ctx, target, { status: "INACTIVE", deactivatedAt: now, deactivatedByUserId: ctx.userId });
    await audit(tx, ctx, {
      action: "staff.invite_revoked",
      resourceType: "user_tenant",
      resourceId: row.id,
      before: { status: target.status, role: target.role },
      after: { status: row.status, role: row.role },
    });
    return toDto(ctx, row);
  });
}

/** SA-STF-04 — role change (`staff.role_changed`, before/after). Setting the current role is a no-op. */
export async function changeMembershipRole(ctx: TenantContext, membershipId: string, role: TenantRole, guard: MembershipGuard): Promise<StaffMemberDto> {
  return withTx(ctx, async (tx) => {
    const current = await readTarget(tx, ctx, membershipId);
    const target = toTarget(current);
    await guard(tx, target);
    if (target.role === role) return toDto(ctx, current);
    const row = await guardedUpdate(tx, ctx, target, { role });
    await audit(tx, ctx, { action: "staff.role_changed", resourceType: "user_tenant", resourceId: row.id, before: { role: target.role }, after: { role: row.role } });
    return toDto(ctx, row);
  });
}

export type DeactivationResult = {
  member: StaffMemberDto;
  /** The person's Clerk user id, when they have ever signed in. */
  clerkUserId: string | null;
  platformRole: PlatformRole;
  /** ACTIVE memberships the person still has in any tenant after this change. */
  otherActiveMemberships: number;
};

/** SA-STF-05 — ACTIVE → INACTIVE (`staff.deactivated`). Access ends on the person's next request (ADR-006 §4). */
export async function deactivateMembership(ctx: TenantContext, membershipId: string, guard: MembershipGuard, now: Date): Promise<DeactivationResult> {
  return withTx(ctx, async (tx) => {
    const target = toTarget(await readTarget(tx, ctx, membershipId));
    await guard(tx, target);
    const row = await guardedUpdate(tx, ctx, target, { status: "INACTIVE", deactivatedAt: now, deactivatedByUserId: ctx.userId });
    await audit(tx, ctx, {
      action: "staff.deactivated",
      resourceType: "user_tenant",
      resourceId: row.id,
      before: { status: target.status, role: target.role },
      after: { status: row.status, role: row.role },
    });
    // tenant-scope-exempt: SC-AUTH-08 session revocation depends on the person's ACTIVE memberships in every tenant; only a count is read
    const otherActiveMemberships = await tx.userTenant.count({ where: { userId: target.userId, status: "ACTIVE" } });
    return { member: toDto(ctx, row), clerkUserId: target.clerkUserId, platformRole: target.platformRole, otherActiveMemberships };
  });
}

/** SA-STF-06 — INACTIVE → ACTIVE for a person who had accepted their invitation (`staff.reactivated`). */
export async function reactivateMembership(ctx: TenantContext, membershipId: string, guard: MembershipGuard): Promise<StaffMemberDto> {
  return withTx(ctx, async (tx) => {
    const target = toTarget(await readTarget(tx, ctx, membershipId));
    await guard(tx, target);
    const row = await guardedUpdate(tx, ctx, target, { status: "ACTIVE", deactivatedAt: null, deactivatedByUserId: null });
    await audit(tx, ctx, {
      action: "staff.reactivated",
      resourceType: "user_tenant",
      resourceId: row.id,
      before: { status: target.status, role: target.role },
      after: { status: row.status, role: row.role },
    });
    return toDto(ctx, row);
  });
}
