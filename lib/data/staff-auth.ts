import "server-only";
import type { Prisma, StaffSessionEndReason, TenantRole } from "@prisma/client";
import { db } from "@/lib/db/prisma";
import { mapErrors } from "./errors";
import type { TenantScopedContext } from "@/lib/auth/context-types";
import { tenantScope } from "./scope";
import type { Tx } from "./tx";

/**
 * Staff daily-password credentials and sessions (RASOIOS-ADR-019).
 *
 * Two kinds of query live here. The *authentication* reads run before any tenant context exists — that is what they
 * are establishing — so they are identity-level, keyed by an email or an opaque session token, exactly like
 * `memberships.ts`. Everything an administrator does afterwards is tenant-scoped in the ordinary way.
 */

/** The roles a daily password may ever authenticate. TENANT_ADMIN and MANAGER keep Clerk (ADR-019 §1). */
export const STAFF_ROLES = ["CASHIER", "KITCHEN", "WAITER"] as const satisfies readonly TenantRole[];
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (role: TenantRole): role is StaffRole => (STAFF_ROLES as readonly TenantRole[]).includes(role);

export type StaffLoginCandidate = {
  credentialId: string;
  passwordHash: string;
  expiresAt: Date;
  failedAttempts: number;
  membershipId: string;
  tenantId: string;
  userId: string;
  role: StaffRole;
  restaurant: { id: string; timezone: string; currencyCode: string };
};

/**
 * Every credential an email could sign in with: ACTIVE membership in an ACTIVE tenant, a staff role, and a live
 * credential. The tenant is *derived* from this, never taken from the request (SC-STAFF-05, C19) — a staff member
 * cannot name a restaurant, only prove they hold its password.
 */
export async function staffLoginCandidates(email: string): Promise<StaffLoginCandidate[]> {
  const rows = await mapErrors("StaffCredential", () =>
    // tenant-scope-exempt: authenticating a person by email, before any tenant context exists (ADR-019 §2).
    db.staffCredential.findMany({
      where: {
        status: "ACTIVE",
        user: { email, status: "ACTIVE" },
        membership: { status: "ACTIVE", role: { in: [...STAFF_ROLES] } },
        // `restaurant: { isNot: null }` — a tenant without a restaurant has no timezone to expire a password in.
        tenant: { status: "ACTIVE", restaurant: { isNot: null } },
      },
      orderBy: { createdAt: "desc" },
      // A person with several staff jobs is rare; the cap keeps a login from becoming N scrypt verifications.
      take: 5,
      select: {
        id: true,
        passwordHash: true,
        expiresAt: true,
        failedAttempts: true,
        membershipId: true,
        tenantId: true,
        userId: true,
        membership: { select: { role: true } },
        tenant: { select: { restaurant: { select: { id: true, timezone: true, currencyCode: true } } } },
      },
    }),
  );
  return rows.map((row) => ({
    credentialId: row.id,
    passwordHash: row.passwordHash,
    expiresAt: row.expiresAt,
    failedAttempts: row.failedAttempts,
    membershipId: row.membershipId,
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.membership.role as StaffRole,
    restaurant: row.tenant.restaurant ?? { id: "", timezone: "UTC", currencyCode: "INR" },
  }));
}

export async function countFailedAttempt(credentialId: string): Promise<void> {
  await mapErrors("StaffCredential", () =>
    // tenant-scope-exempt: the row was already resolved by `staffLoginCandidates`; this only increments its counter.
    db.staffCredential.update({ where: { id: credentialId }, data: { failedAttempts: { increment: 1 } } }),
  );
}

export type StaffSessionRow = {
  sessionId: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  role: StaffRole;
  expiresAt: Date;
};

/**
 * Starts a shift. Any session still open for this membership is ended first: the partial unique index allows only
 * one, and a staff member signing in on a second device should move their shift, not fork it.
 */
export async function openStaffSession(input: {
  tx: Tx;
  tenantId: string;
  membershipId: string;
  userId: string;
  credentialId: string;
  role: StaffRole;
  tokenHash: string;
  businessDate: Date;
  expiresAt: Date;
  at: Date;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<StaffSessionRow> {
  return mapErrors("StaffSession", async () => {
    {
      const tx = input.tx;
      await tx.staffSession.updateMany({
        where: { tenantId: input.tenantId, membershipId: input.membershipId, status: "ACTIVE" },
        data: { status: "ENDED", endReason: "SIGNED_OUT", endedAt: input.at },
      });
      const created = await tx.staffSession.create({
        data: {
          tenantId: input.tenantId,
          membershipId: input.membershipId,
          userId: input.userId,
          credentialId: input.credentialId,
          role: input.role,
          tokenHash: input.tokenHash,
          businessDate: input.businessDate,
          expiresAt: input.expiresAt,
          loginAt: input.at,
          lastSeenAt: input.at,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
        select: { id: true },
      });
      // Scoped by tenant as well as id, even though the credential was just resolved: a successful sign-in is the
      // wrong moment to be the one write in this file that trusts an id on its own.
      await tx.staffCredential.updateMany({
        where: { tenantId: input.tenantId, id: input.credentialId },
        data: { failedAttempts: 0 },
      });
      return {
        sessionId: created.id,
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        userId: input.userId,
        role: input.role,
        expiresAt: input.expiresAt,
      };
    }
  });
}

export type ResolvedStaffSession = {
  sessionId: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  role: StaffRole;
  expiresAt: Date;
  restaurant: { id: string; timezone: string; currencyCode: string };
  /** False when the membership, tenant or user has since been suspended, disabled or had its role changed. */
  stillEligible: boolean;
};

/**
 * The session behind a cookie token, re-read on every request (ADR-019 §4, C10).
 *
 * This is why a force logout takes effect immediately: the row is the authority, not the cookie. It also re-checks
 * the membership, tenant and user each time, so disabling a staff member or changing their role out of a staff role
 * ends their access at the next request without anyone having to hunt down their session.
 */
export async function resolveStaffSession(tokenHash: string): Promise<ResolvedStaffSession | null> {
  const row = await mapErrors("StaffSession", () =>
    // tenant-scope-exempt: resolving who the caller is from an opaque token — this establishes the tenant.
    db.staffSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        membershipId: true,
        userId: true,
        role: true,
        status: true,
        expiresAt: true,
        membership: { select: { status: true, role: true } },
        tenant: { select: { status: true, restaurant: { select: { id: true, timezone: true, currencyCode: true } } } },
        user: { select: { status: true } },
      },
    }),
  );
  if (!row || row.status !== "ACTIVE") return null;
  return {
    sessionId: row.id,
    tenantId: row.tenantId,
    membershipId: row.membershipId,
    userId: row.userId,
    role: row.role as StaffRole,
    expiresAt: row.expiresAt,
    restaurant: row.tenant.restaurant ?? { id: "", timezone: "UTC", currencyCode: "INR" },
    stillEligible:
      row.tenant.restaurant !== null &&
      row.membership.status === "ACTIVE" && isStaffRole(row.membership.role) && row.tenant.status === "ACTIVE" && row.user.status === "ACTIVE",
  };
}

export async function touchStaffSession(sessionId: string, at: Date): Promise<void> {
  await mapErrors("StaffSession", () =>
    // tenant-scope-exempt: the session was just resolved by its own token; this records that it is still in use.
    db.staffSession.update({ where: { id: sessionId }, data: { lastSeenAt: at } }),
  );
}

/** Ends one session by id. Used by sign-out and by the expiry path, where there is no administrator acting. */
export async function endStaffSessionById(sessionId: string, reason: StaffSessionEndReason, at: Date, endedByUserId?: string): Promise<void> {
  await mapErrors("StaffSession", () =>
    // tenant-scope-exempt: reached either from the session's own token or from a tenant-scoped admin action below.
    db.staffSession.updateMany({
      where: { id: sessionId, status: "ACTIVE" },
      data: { status: "ENDED", endReason: reason, endedAt: at, endedByUserId: endedByUserId ?? null },
    }),
  );
}

/** Force logout (C10). Tenant-scoped: an administrator can only end sessions inside their own restaurant. */
export async function endActiveSessionsForMembership(
  ctx: TenantScopedContext,
  input: { tx: Tx; membershipId: string; reason: StaffSessionEndReason; at: Date; endedByUserId: string },
): Promise<number> {
  const result = await mapErrors("StaffSession", () =>
    input.tx.staffSession.updateMany({
      where: tenantScope(ctx, { membershipId: input.membershipId, status: "ACTIVE" as const }),
      data: { status: "ENDED", endReason: input.reason, endedAt: input.at, endedByUserId: input.endedByUserId },
    }),
  );
  return result.count;
}

/**
 * Issues today's password. Revoking the previous one and inserting the new one happen together, so the moment a new
 * password exists the old one is already dead (C14) — and the partial unique index refuses the insert otherwise.
 */
export async function replaceStaffCredential(
  ctx: TenantScopedContext,
  input: { tx: Tx; membershipId: string; userId: string; passwordHash: string; businessDate: Date; expiresAt: Date; generatedByUserId: string; at: Date },
): Promise<{ credentialId: string; replacedPrevious: boolean }> {
  return mapErrors("StaffCredential", async () => {
    {
      const tx = input.tx;
      const revoked = await tx.staffCredential.updateMany({
        where: tenantScope(ctx, { membershipId: input.membershipId, status: "ACTIVE" as const }),
        data: { status: "REVOKED", revokedAt: input.at },
      });
      const created = await tx.staffCredential.create({
        data: {
          tenantId: ctx.tenantId,
          membershipId: input.membershipId,
          userId: input.userId,
          passwordHash: input.passwordHash,
          businessDate: input.businessDate,
          expiresAt: input.expiresAt,
          generatedByUserId: input.generatedByUserId,
        },
        select: { id: true },
      });
      return { credentialId: created.id, replacedPrevious: revoked.count > 0 };
    }
  });
}

/** Revokes today's password without issuing another, and ends any shift it is holding open. */
export async function revokeStaffCredential(
  ctx: TenantScopedContext,
  input: { tx: Tx; membershipId: string; at: Date; endedByUserId: string },
): Promise<number> {
  return mapErrors("StaffCredential", async () => {
    {
      const tx = input.tx;
      const revoked = await tx.staffCredential.updateMany({
        where: tenantScope(ctx, { membershipId: input.membershipId, status: "ACTIVE" as const }),
        data: { status: "REVOKED", revokedAt: input.at },
      });
      if (revoked.count > 0) {
        await tx.staffSession.updateMany({
          where: tenantScope(ctx, { membershipId: input.membershipId, status: "ACTIVE" as const }),
          data: { status: "ENDED", endReason: "CREDENTIAL_REVOKED", endedAt: input.at, endedByUserId: input.endedByUserId },
        });
      }
      return revoked.count;
    }
  });
}

/** Does this membership belong to this tenant, and is it a staff role a password may be issued for? */
export async function staffMembershipForCredential(
  ctx: TenantScopedContext,
  membershipId: string,
): Promise<{ membershipId: string; userId: string; role: StaffRole; fullName: string | null; email: string } | null> {
  const row = await mapErrors("Membership", () =>
    db.userTenant.findFirst({
      where: tenantScope(ctx, { id: membershipId, status: "ACTIVE" as const }),
      select: { id: true, userId: true, role: true, user: { select: { fullName: true, email: true } } },
    }),
  );
  if (!row || !isStaffRole(row.role)) return null;
  return { membershipId: row.id, userId: row.userId, role: row.role, fullName: row.user.fullName, email: row.user.email };
}

export type StaffStandingRow = {
  membershipId: string;
  userId: string;
  role: StaffRole;
  fullName: string | null;
  email: string;
  credential: { expiresAt: Date; businessDate: Date; generatedAt: Date } | null;
  activeSession: { sessionId: string; loginAt: Date } | null;
};

/** Everyone a daily password applies to, with today's credential and any open shift (C11, C13). */
export async function listStaffStanding(ctx: TenantScopedContext): Promise<StaffStandingRow[]> {
  const rows = await mapErrors("Membership", () =>
    db.userTenant.findMany({
      where: tenantScope(ctx, { status: "ACTIVE" as const, role: { in: [...STAFF_ROLES] } }),
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        userId: true,
        role: true,
        user: { select: { fullName: true, email: true } },
        staffCredentials: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { expiresAt: true, businessDate: true, createdAt: true },
        },
        staffSessions: {
          where: { status: "ACTIVE" },
          orderBy: { loginAt: "desc" },
          take: 1,
          select: { id: true, loginAt: true },
        },
      },
    }),
  );
  return rows.map((row) => ({
    membershipId: row.id,
    userId: row.userId,
    role: row.role as StaffRole,
    fullName: row.user.fullName,
    email: row.user.email,
    credential: row.staffCredentials[0]
      ? { expiresAt: row.staffCredentials[0].expiresAt, businessDate: row.staffCredentials[0].businessDate, generatedAt: row.staffCredentials[0].createdAt }
      : null,
    activeSession: row.staffSessions[0] ? { sessionId: row.staffSessions[0].id, loginAt: row.staffSessions[0].loginAt } : null,
  }));
}

export type AttendanceSessionRow = {
  sessionId: string;
  membershipId: string;
  fullName: string | null;
  role: StaffRole;
  businessDate: Date;
  loginAt: Date;
  endedAt: Date | null;
  endReason: StaffSessionEndReason | null;
  status: "ACTIVE" | "ENDED";
};

/** Every shift in a business-date range, newest first — the raw rows attendance totals are computed from (C9). */
export async function listStaffSessions(ctx: TenantScopedContext, from: Date, to: Date): Promise<AttendanceSessionRow[]> {
  const rows = await mapErrors("StaffSession", () =>
    db.staffSession.findMany({
      where: tenantScope(ctx, { businessDate: { gte: from, lte: to } } satisfies Prisma.StaffSessionWhereInput),
      orderBy: [{ businessDate: "desc" }, { loginAt: "desc" }],
      take: 500,
      select: {
        id: true,
        membershipId: true,
        role: true,
        businessDate: true,
        loginAt: true,
        endedAt: true,
        endReason: true,
        status: true,
        user: { select: { fullName: true } },
      },
    }),
  );
  return rows.map((row) => ({
    sessionId: row.id,
    membershipId: row.membershipId,
    fullName: row.user.fullName,
    role: row.role as StaffRole,
    businessDate: row.businessDate,
    loginAt: row.loginAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    status: row.status,
  }));
}
