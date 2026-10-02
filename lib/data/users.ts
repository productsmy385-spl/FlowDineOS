import "server-only";
import type { MembershipStatus, PlatformRole, Prisma, TenantRole, ThemePreference, UserStatus } from "@prisma/client";
import { db } from "@/lib/db/prisma";
import { mapErrors } from "./errors";

/**
 * Global identity data (USER is not tenant-owned). Used only by the session resolver and platform services.
 * Linking follows ADR-006 §2: a Clerk identity is attached to a pre-created USER only by the Clerk-verified primary
 * email, and only when that USER was invited (an INVITED membership) or granted the SUPER_ADMIN platform role.
 */

export type IdentityUser = {
  id: string;
  email: string;
  fullName: string | null;
  platformRole: PlatformRole;
  status: UserStatus;
  clerkUserId: string | null;
};

const identitySelect = { id: true, email: true, fullName: true, platformRole: true, status: true, clerkUserId: true } as const;

export async function findUserByClerkId(clerkUserId: string, client: Prisma.TransactionClient = db): Promise<IdentityUser | null> {
  return mapErrors("User", () => client.user.findUnique({ where: { clerkUserId }, select: identitySelect }));
}

export type LinkResult =
  | { outcome: "LINKED"; user: IdentityUser; activatedMemberships: Array<{ id: string; tenantId: string; role: TenantRole }> }
  | { outcome: "NOT_INVITED" }
  | { outcome: "CONFLICT" };

/**
 * Attaches `clerkUserId` to the invited USER with this (already verified, lowercased) email and activates its
 * INVITED memberships, writing `user.linked` and `staff.activated` audit rows — all in one transaction.
 */
export async function linkInvitedUser(email: string, clerkUserId: string, now: Date, requestId: string): Promise<LinkResult> {
  return mapErrors("User", () =>
    db.$transaction(async (tx) => {
      const candidate = await tx.user.findUnique({
        where: { email },
        select: { ...identitySelect, memberships: { where: { status: "INVITED" as MembershipStatus }, select: { id: true, tenantId: true, role: true } } },
      });
      if (!candidate) return { outcome: "NOT_INVITED" } as const;
      // Already linked to a different Clerk account: never re-point an identity automatically (account takeover risk).
      if (candidate.clerkUserId && candidate.clerkUserId !== clerkUserId) return { outcome: "CONFLICT" } as const;
      if (candidate.memberships.length === 0 && candidate.platformRole !== "SUPER_ADMIN") return { outcome: "NOT_INVITED" } as const;

      // Guarded update: only succeeds if nobody linked this row concurrently.
      const linked = await tx.user.updateMany({
        where: { id: candidate.id, OR: [{ clerkUserId: null }, { clerkUserId }] },
        data: { clerkUserId, lastSignInAt: now },
      });
      if (linked.count === 0) return { outcome: "CONFLICT" } as const;

      // tenant-scope-exempt: activates the signed-in user's own invitations, which may span tenants (ADR-006 §2)
      await tx.userTenant.updateMany({
        where: { userId: candidate.id, status: "INVITED" },
        data: { status: "ACTIVE", acceptedAt: now },
      });

      await tx.auditLog.createMany({
        data: [
          {
            tenantId: null,
            actorType: "USER",
            actorUserId: candidate.id,
            action: "user.linked",
            resourceType: "user",
            resourceId: candidate.id,
            afterState: { clerkLinked: true },
            requestId,
          },
          ...candidate.memberships.map((m) => ({
            tenantId: m.tenantId,
            actorType: "USER" as const,
            actorUserId: candidate.id,
            actorRole: m.role,
            action: "staff.activated",
            resourceType: "user_tenant",
            resourceId: m.id,
            beforeState: { status: "INVITED" },
            afterState: { status: "ACTIVE" },
            requestId,
          })),
        ],
      });

      const { memberships, ...user } = candidate;
      return { outcome: "LINKED", user: { ...user, clerkUserId }, activatedMemberships: memberships } as const;
    }),
  );
}

/** Records a sign-in at most once per `minIntervalMs` (default 15 minutes) with a single conditional UPDATE. */
/** The identity behind a staff session (ADR-019 §4), resolved after the session row has already proved who it is. */
export async function findUserById(userId: string): Promise<IdentityUser | null> {
  return mapErrors("User", () =>
    // tenant-scope-exempt: identity-level read, keyed by the id the staff session itself carries.
    db.user.findUnique({ where: { id: userId }, select: identitySelect }),
  );
}

export async function touchLastSignIn(userId: string, now: Date, minIntervalMs = 15 * 60_000): Promise<void> {
  const threshold = new Date(now.getTime() - minIntervalMs);
  await mapErrors("User", () =>
    db.user.updateMany({
      where: { id: userId, OR: [{ lastSignInAt: null }, { lastSignInAt: { lt: threshold } }] },
      data: { lastSignInAt: now },
    }),
  );
}

/**
 * The person's console colour scheme (ADR-016). A display preference of the signed-in user's own row — not a
 * security-relevant change — so, like `lastSignInAt`, it is not audited.
 */
export async function findThemePreference(userId: string): Promise<ThemePreference | null> {
  const row = await mapErrors("User", () => db.user.findUnique({ where: { id: userId }, select: { themePreference: true } }));
  return row?.themePreference ?? null;
}

export async function saveThemePreference(userId: string, themePreference: ThemePreference): Promise<void> {
  await mapErrors("User", () => db.user.update({ where: { id: userId }, data: { themePreference }, select: { id: true } }));
}

export type ClerkProfile = { clerkUserId: string; verifiedPrimaryEmail: string | null; fullName: string | null };

/**
 * `user.updated` webhook sync (S1-P03-T008): name, and email when Clerk has verified it. An email already used by
 * another USER is not applied (reported as `EMAIL_CONFLICT`). Unknown Clerk users are ignored.
 */
export async function syncClerkProfile(profile: ClerkProfile, requestId: string): Promise<"UPDATED" | "UNCHANGED" | "UNKNOWN_USER" | "EMAIL_CONFLICT"> {
  return mapErrors("User", () =>
    db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { clerkUserId: profile.clerkUserId }, select: { id: true, email: true, fullName: true } });
      if (!user) return "UNKNOWN_USER" as const;

      const data: { email?: string; fullName?: string | null } = {};
      let conflict = false;
      if (profile.verifiedPrimaryEmail && profile.verifiedPrimaryEmail !== user.email) {
        const owner = await tx.user.findUnique({ where: { email: profile.verifiedPrimaryEmail }, select: { id: true } });
        if (owner && owner.id !== user.id) conflict = true;
        else data.email = profile.verifiedPrimaryEmail;
      }
      if (profile.fullName !== null && profile.fullName !== user.fullName) data.fullName = profile.fullName;
      if (Object.keys(data).length === 0) return conflict ? ("EMAIL_CONFLICT" as const) : ("UNCHANGED" as const);

      await tx.user.update({ where: { id: user.id }, data });
      await tx.auditLog.create({
        data: {
          actorType: "WEBHOOK",
          action: data.email ? "user.email_synced" : "user.profile_synced",
          resourceType: "user",
          resourceId: user.id,
          beforeState: { emailChanged: Boolean(data.email), nameChanged: data.fullName !== undefined },
          afterState: { emailChanged: Boolean(data.email), nameChanged: data.fullName !== undefined },
          requestId,
        },
      });
      return conflict ? ("EMAIL_CONFLICT" as const) : ("UPDATED" as const);
    }),
  );
}

/**
 * `user.deleted` webhook (S1-P03-T008): the local USER becomes INACTIVE and every ACTIVE/INVITED membership INACTIVE,
 * with audit rows. Idempotent: a replay finds nothing left to change and writes nothing.
 */
export async function deactivateClerkUser(clerkUserId: string, now: Date, requestId: string): Promise<"DEACTIVATED" | "UNCHANGED" | "UNKNOWN_USER"> {
  return mapErrors("User", () =>
    db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { clerkUserId },
        select: { id: true, status: true, memberships: { where: { status: { in: ["ACTIVE", "INVITED"] } }, select: { id: true, tenantId: true, status: true } } },
      });
      if (!user) return "UNKNOWN_USER" as const;
      if (user.status === "INACTIVE" && user.memberships.length === 0) return "UNCHANGED" as const;

      if (user.status !== "INACTIVE") await tx.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });
      // tenant-scope-exempt: deactivates one deleted identity's memberships across all tenants (ADR-006, RH-AUTH-01)
      await tx.userTenant.updateMany({
        where: { userId: user.id, status: { in: ["ACTIVE", "INVITED"] } },
        data: { status: "INACTIVE", deactivatedAt: now },
      });
      await tx.auditLog.createMany({
        data: [
          ...(user.status !== "INACTIVE"
            ? [{ actorType: "WEBHOOK" as const, action: "user.status_changed", resourceType: "user", resourceId: user.id, beforeState: { status: user.status }, afterState: { status: "INACTIVE" }, reason: "Deleted in Clerk", requestId }]
            : []),
          ...user.memberships.map((m) => ({
            tenantId: m.tenantId,
            actorType: "WEBHOOK" as const,
            action: "staff.deactivated",
            resourceType: "user_tenant",
            resourceId: m.id,
            beforeState: { status: m.status },
            afterState: { status: "INACTIVE" },
            reason: "Deleted in Clerk",
            requestId,
          })),
        ],
      });
      return "DEACTIVATED" as const;
    }),
  );
}
