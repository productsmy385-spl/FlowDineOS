import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { auth, currentUser } from "@clerk/nextjs/server";
import { findUserByClerkId, linkInvitedUser, touchLastSignIn, type IdentityUser } from "@/lib/data/users";
import { logger } from "@/lib/logger";
import { now } from "@/lib/time/clock";

/**
 * Session resolver (S1-P03-T003, ADR-006, security.md §2.2): Clerk identity → local USER.
 *
 * - Known Clerk user → its USER (ACTIVE, or INACTIVE for any other status).
 * - Unknown Clerk user → link to an invited USER by the Clerk-*verified* primary email, once, in a transaction.
 * - Anyone else → NO_ACCOUNT, with no database write (no accounts for uninvited people; BA-05).
 * - Errors propagate (mapped to 503 by lib/data), never "signed out" (SC-AUTH-09; BA-06 removed the blanket catch).
 */

/**
 * How the caller proved who they are. This is not a detail: it decides which of their memberships they can reach.
 * A Clerk session never reaches a staff-role membership, and a daily password reaches only the one membership it
 * was issued for (RASOIOS-ADR-019 §1).
 */
export type AuthMethod = { via: "CLERK" } | { via: "STAFF_PASSWORD"; membershipId: string };

export type SessionState =
  | { state: "SIGNED_OUT" }
  | { state: "NO_ACCOUNT" }
  | { state: "INACTIVE"; userId: string }
  | ({ state: "ACTIVE"; user: IdentityUser } & AuthMethod);

export type ClerkIdentity = {
  clerkUserId: string;
  /** Fetched only when linking is needed (one Clerk Backend API call on first sign-in). */
  verifiedPrimaryEmail: () => Promise<string | null>;
};

export async function resolveSession(identity: ClerkIdentity | null, requestId: string): Promise<SessionState> {
  if (!identity) return { state: "SIGNED_OUT" };

  const existing = await findUserByClerkId(identity.clerkUserId);
  if (existing) {
    if (existing.status !== "ACTIVE") return { state: "INACTIVE", userId: existing.id };
    await touchLastSignIn(existing.id, now());
    return { state: "ACTIVE", user: existing, via: "CLERK" };
  }

  const email = await identity.verifiedPrimaryEmail();
  if (!email) return { state: "NO_ACCOUNT" };

  const result = await linkInvitedUser(email, identity.clerkUserId, now(), requestId);
  if (result.outcome === "CONFLICT") {
    logger.warn("security.identity_conflict", { requestId, reason: "email already linked to another Clerk user" });
    return { state: "NO_ACCOUNT" };
  }
  if (result.outcome === "NOT_INVITED") return { state: "NO_ACCOUNT" };
  if (result.user.status !== "ACTIVE") return { state: "INACTIVE", userId: result.user.id };
  logger.info("auth.user_linked", { requestId, userId: result.user.id, memberships: result.activatedMemberships.length });
  return { state: "ACTIVE", user: result.user, via: "CLERK" };
}

/** Lowercased primary email of a Clerk user, only if Clerk has verified it. */
export function verifiedPrimaryEmailOf(user: {
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{ id: string; emailAddress: string; verification: { status: string } | null }>;
}): string | null {
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.emailAddress.trim().toLowerCase();
}

async function requestIdFromHeaders(): Promise<string> {
  try {
    return (await headers()).get("x-request-id") ?? "no-request-id";
  } catch {
    return "no-request-id"; // outside a request scope (scripts)
  }
}

/**
 * The current request's session, resolved once per request (React cache).
 *
 * Clerk first, then a staff daily-password session (RASOIOS-ADR-019). Deliberately in that order and mutually
 * exclusive: an administrator or manager signed in with Clerk is never re-resolved as staff, and the staff path is
 * only reached when Clerk has no session at all, so the two can never be combined to widen anyone's access.
 *
 * Resolving staff into the *same* `SessionState` is the whole design. Everything downstream — `resolveTenant`,
 * every guard, every permission check, every `tenantScope` — then works on a staff session without knowing one
 * exists, so there is no second authorization path to keep in step with the first.
 */
export const getSessionUser = cache(async (): Promise<SessionState> => {
  const { userId } = await auth();
  if (userId) {
    const identity: ClerkIdentity = {
      clerkUserId: userId,
      verifiedPrimaryEmail: async () => {
        const user = await currentUser();
        return user ? verifiedPrimaryEmailOf(user) : null;
      },
    };
    return resolveSession(identity, await requestIdFromHeaders());
  }
  return resolveStaffSessionState();
});

/**
 * A staff cookie resolved to the same shape Clerk produces. `currentStaffSession` re-reads the session row, so a
 * revoked, expired or no-longer-eligible session is already closed by the time this returns null.
 */
async function resolveStaffSessionState(): Promise<SessionState> {
  const { currentStaffSession } = await import("@/lib/services/staff-auth");
  const { STAFF_SESSION_COOKIE, parseStaffSessionCookie } = await import("./staff-session-cookie");
  const { findUserById } = await import("@/lib/data/users");

  let token: string | null = null;
  try {
    token = parseStaffSessionCookie((await cookies()).get(STAFF_SESSION_COOKIE)?.value);
  } catch {
    return { state: "SIGNED_OUT" }; // outside a request scope (scripts)
  }
  if (!token) return { state: "SIGNED_OUT" };

  const session = await currentStaffSession(token);
  if (!session) return { state: "SIGNED_OUT" };

  const user = await findUserById(session.userId);
  if (!user) return { state: "SIGNED_OUT" };
  if (user.status !== "ACTIVE") return { state: "INACTIVE", userId: user.id };
  return { state: "ACTIVE", user, via: "STAFF_PASSWORD", membershipId: session.membershipId };
}
