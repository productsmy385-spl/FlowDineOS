import "server-only";
import { audit } from "@/lib/audit/write";
import {
  countFailedAttempt,
  endActiveSessionsForMembership,
  endStaffSessionById,
  isStaffRole,
  openStaffSession,
  replaceStaffCredential,
  resolveStaffSession,
  revokeStaffCredential,
  staffLoginCandidates,
  staffMembershipForCredential,
  touchStaffSession,
  type ResolvedStaffSession,
  type StaffRole,
} from "@/lib/data/staff-auth";
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { TenantContext } from "@/lib/auth/context-types";
import { permissionsForTenantRole, type Permission } from "@/lib/auth/permissions";
import { generateStaffPassword, hashStaffPassword, verifyStaffPassword } from "@/lib/auth/staff-password";
import { hashStaffSessionToken, issueStaffSessionToken } from "@/lib/auth/staff-session-cookie";
import { withTx } from "@/lib/data/tx";
import { consumeScope } from "@/lib/security/rate-limit";
import { businessDateFor } from "@/lib/time/business-date";
import { now } from "@/lib/time/clock";
import { zonedTimeToUtc } from "@/lib/time/zone";

/**
 * Staff daily-password authentication (RASOIOS-ADR-019).
 *
 * Deliberately separate from the Clerk path in `lib/auth/session.ts`: administrators and managers keep the identity
 * provider, and staff get a credential their own administrator issues each morning. Nothing here can authenticate
 * a TENANT_ADMIN or MANAGER — the role is filtered in the query, checked again here, and refused a third time by a
 * CHECK constraint on `staff_sessions.role`.
 */

/** The end of the restaurant's business day: next local midnight, resolved through its own IANA timezone (C4). */
export function endOfBusinessDay(businessDate: Date, timeZone: string): Date {
  const iso = businessDate.toISOString().slice(0, 10);
  const [year, month, day] = iso.split("-").map(Number);
  return zonedTimeToUtc({ year, month, day: day + 1, hour: 0, minute: 0 }, timeZone);
}

export type StaffLoginOutcome =
  | { outcome: "OK"; token: string; session: { tenantId: string; membershipId: string; userId: string; role: StaffRole }; expiresAt: Date }
  | { outcome: "INVALID" }
  | { outcome: "EXPIRED" };

/**
 * Verifies an email and today's password, and starts a shift.
 *
 * The tenant is derived from whichever credential the password actually matches — the caller never names one, so a
 * staff member cannot reach another restaurant by changing a field (C19, SC-STAFF-05). Wrong email and wrong
 * password are the same answer to the caller, and the same amount of work is done either way, so neither tells an
 * attacker whether an account exists.
 */
export async function staffLogin(input: {
  email: string;
  password: string;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<StaffLoginOutcome> {
  const email = input.email.trim().toLowerCase();
  const at = now();

  // Two buckets: one per identifier so one person's typos cannot lock out the restaurant, one per address so a
  // spray across many emails from one machine is still stopped (C18).
  for (const [scope, identifier] of [
    ["staff.login.identifier", email],
    ["staff.login.address", input.ipAddress ?? "unknown"],
  ] as const) {
    const limit = await consumeScope(scope, identifier);
    if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSec, "Too many sign-in attempts. Try again shortly.");
  }

  const candidates = await staffLoginCandidates(email);
  let expiredSeen = false;

  for (const candidate of candidates) {
    if (!isStaffRole(candidate.role)) continue; // belt and braces: the query already filters these out
    const matches = await verifyStaffPassword(input.password, candidate.passwordHash);
    if (!matches) {
      await countFailedAttempt(candidate.credentialId);
      continue;
    }
    if (candidate.expiresAt <= at) {
      expiredSeen = true;
      continue;
    }

    const { token, tokenHash } = issueStaffSessionToken();
    const businessDate = businessDateFor(at, candidate.restaurant.timezone);
    // The shift and its audit row commit together: an attendance record with no trail, or a trail with no shift,
    // would both be wrong in a way nobody could later reconstruct (SC-AUD-01).
    const sessionCtx: TenantContext = {
      kind: "tenant",
      requestId: input.requestId,
      userId: candidate.userId,
      membershipId: candidate.membershipId,
      tenantId: candidate.tenantId,
      role: candidate.role,
      permissions: permissionsForTenantRole(candidate.role) as ReadonlySet<Permission>,
      restaurant: { id: candidate.restaurant.id, timezone: candidate.restaurant.timezone, currencyCode: candidate.restaurant.currencyCode },
    };
    const session = await withTx(sessionCtx, async (tx) => {
      const opened = await openStaffSession({
        tx,
        tenantId: candidate.tenantId,
        membershipId: candidate.membershipId,
        userId: candidate.userId,
        credentialId: candidate.credentialId,
        role: candidate.role,
        tokenHash,
        businessDate,
        expiresAt: candidate.expiresAt,
        at,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
      });
      await audit(tx, sessionCtx, {
        action: "staff.login",
        resourceType: "staff_session",
        resourceId: opened.sessionId,
        after: { membershipId: candidate.membershipId, role: candidate.role },
      });
      return opened;
    });
    logger.info("staff.login", { requestId: input.requestId, tenantId: candidate.tenantId, membershipId: candidate.membershipId });
    return { outcome: "OK", token, session, expiresAt: candidate.expiresAt };
  }

  // Nothing identifying in the log line: no email, no password, no hint about which of the two was wrong (L, C20).
  logger.warn("staff.login_failed", { requestId: input.requestId, reason: expiredSeen ? "EXPIRED" : "INVALID" });
  return expiredSeen ? { outcome: "EXPIRED" } : { outcome: "INVALID" };
}

/**
 * The staff session behind a cookie token, if it is still good for this request.
 *
 * Re-read every request, which is what makes a force logout immediate and what ends access the moment a membership
 * is suspended or moved off a staff role. An expired session is closed here rather than left to a sweeper, so
 * attendance shows a real end time instead of a shift that never finished.
 */
export async function currentStaffSession(token: string | null): Promise<ResolvedStaffSession | null> {
  if (!token) return null;
  const session = await resolveStaffSession(hashStaffSessionToken(token));
  if (!session) return null;

  const at = now();
  if (session.expiresAt <= at) {
    await endStaffSessionById(session.sessionId, "EXPIRED", at);
    return null;
  }
  if (!session.stillEligible) {
    await endStaffSessionById(session.sessionId, "ADMIN_FORCE_LOGOUT", at);
    return null;
  }
  await touchStaffSession(session.sessionId, at);
  return session;
}

/** Staff signing themselves out. */
export async function staffSignOut(token: string | null, requestId: string): Promise<void> {
  if (!token) return;
  const session = await resolveStaffSession(hashStaffSessionToken(token));
  if (!session) return;
  const at = now();
  const ctx: TenantContext = {
    kind: "tenant",
    requestId,
    userId: session.userId,
    membershipId: session.membershipId,
    tenantId: session.tenantId,
    role: session.role,
    permissions: permissionsForTenantRole(session.role) as ReadonlySet<Permission>,
    restaurant: session.restaurant,
  };
  await endStaffSessionById(session.sessionId, "SIGNED_OUT", at);
  await withTx(ctx, (tx) =>
    audit(tx, ctx, {
      action: "staff.logout",
      resourceType: "staff_session",
      resourceId: session.sessionId,
      after: { membershipId: session.membershipId },
    }),
  );
}

/**
 * Issues (or reissues) today's password. Returns the plaintext once — this is the only moment it exists outside the
 * administrator's screen; the database keeps a scrypt hash and nothing else (C5).
 */
export async function generateDailyPassword(ctx: TenantContext, membershipId: string): Promise<{ password: string; expiresAt: Date; reissued: boolean; staffName: string }> {
  const membership = await staffMembershipForCredential(ctx, membershipId);
  // Same answer for "not in this restaurant" and "not a staff role": an administrator has no business learning
  // which of the two it was for an id they guessed (C19).
  if (!membership) throw new NotFoundError("That staff member does not exist here.");

  const at = now();
  const businessDate = businessDateFor(at, ctx.restaurant.timezone);
  const expiresAt = endOfBusinessDay(businessDate, ctx.restaurant.timezone);
  const password = generateStaffPassword();

  const passwordHash = await hashStaffPassword(password);
  const { replacedPrevious } = await withTx(ctx, async (tx) => {
    const result = await replaceStaffCredential(ctx, {
      tx,
      membershipId,
      userId: membership.userId,
      passwordHash,
      businessDate,
      expiresAt,
      generatedByUserId: ctx.userId,
      at,
    });
    await audit(tx, ctx, {
      action: result.replacedPrevious ? "staff.password_regenerated" : "staff.password_generated",
      resourceType: "staff_credential",
      resourceId: result.credentialId,
      // The business date and who it is for — never the password, and never its hash (ADR-019 §6, L).
      after: { membershipId, businessDate: businessDate.toISOString().slice(0, 10), expiresAt: expiresAt.toISOString() },
    });
    return result;
  });
  return { password, expiresAt, reissued: replacedPrevious, staffName: membership.fullName ?? membership.email };
}

/** Revokes today's password and ends any shift it was holding open. */
export async function revokeDailyPassword(ctx: TenantContext, membershipId: string): Promise<void> {
  const membership = await staffMembershipForCredential(ctx, membershipId);
  if (!membership) throw new NotFoundError("That staff member does not exist here.");

  const at = now();
  const revoked = await withTx(ctx, async (tx) => {
    const count = await revokeStaffCredential(ctx, { tx, membershipId, at, endedByUserId: ctx.userId });
    if (count > 0) {
      await audit(tx, ctx, { action: "staff.password_revoked", resourceType: "staff_credential", resourceId: membershipId, after: { membershipId } });
    }
    return count;
  });
  if (revoked === 0) throw new ValidationError("There is no password to revoke.");
}

/**
 * Force logout (C10). Ends the server-side session, so the staff member loses access on their next request rather
 * than when their browser happens to notice.
 */
export async function forceLogoutStaff(ctx: TenantContext, membershipId: string): Promise<{ ended: number }> {
  const membership = await staffMembershipForCredential(ctx, membershipId);
  if (!membership) throw new NotFoundError("That staff member does not exist here.");

  const at = now();
  const ended = await withTx(ctx, async (tx) => {
    const count = await endActiveSessionsForMembership(ctx, { tx, membershipId, reason: "ADMIN_FORCE_LOGOUT", at, endedByUserId: ctx.userId });
    if (count > 0) {
      await audit(tx, ctx, { action: "staff.force_logout", resourceType: "staff_session", resourceId: membershipId, after: { membershipId, endedSessions: count } });
    }
    return count;
  });
  if (ended === 0) throw new ValidationError("That staff member is not signed in.");
  return { ended };
}

/** Only a TENANT_ADMIN administers staff authentication; MANAGER keeps its existing permissions (C17). */
export function assertStaffAdmin(ctx: TenantContext): void {
  if (ctx.role !== "TENANT_ADMIN") {
    logger.warn("security.forbidden", { requestId: ctx.requestId, permission: "staff:credentials" });
    throw new ForbiddenError();
  }
}
