import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { activeMembershipsOfUser, type MembershipRow } from "@/lib/data/memberships";
import { ACTIVE_MEMBERSHIP_COOKIE, parseActiveMembershipCookie } from "./active-membership-cookie";
import type { PlatformContext, TenantContext } from "./context-types";
import { withoutDisabledFeatures } from "./features";
import { permissionsForPlatformRole, permissionsForTenantRole, type Permission } from "./permissions";
import { getSessionUser, type SessionState } from "./session";

/**
 * Tenant and platform context resolution (S1-P04-T001, ADR-006 §3–4, tenant-isolation.md §2).
 *
 * Every request re-reads the user, memberships, roles and tenant status from PostgreSQL (fresh authorization data),
 * memoised per request with React `cache()`. No function here accepts a tenant identifier from a caller: the tenant
 * is the one on the user's own ACTIVE membership, optionally chosen by the re-validated preference cookie.
 */

export type MembershipSummary = { membershipId: string; tenantName: string; role: MembershipRow["role"]; suspended: boolean };

export type TenantResolution =
  | { outcome: "OK"; ctx: TenantContext; memberships: MembershipSummary[] }
  | { outcome: "SIGNED_OUT" }
  | { outcome: "NO_ACCOUNT" }
  | { outcome: "ACCOUNT_INACTIVE" }
  | { outcome: "NO_MEMBERSHIP" }
  | { outcome: "SUSPENDED"; canSwitch: boolean; memberships: MembershipSummary[] }
  | { outcome: "SELECT_REQUIRED"; memberships: MembershipSummary[] };

export type PlatformResolution =
  | { outcome: "OK"; ctx: PlatformContext }
  | { outcome: "SIGNED_OUT" }
  | { outcome: "NO_ACCOUNT" }
  | { outcome: "ACCOUNT_INACTIVE" }
  | { outcome: "NOT_PLATFORM_ADMIN" };

const summary = (m: MembershipRow): MembershipSummary => ({
  membershipId: m.membershipId,
  tenantName: m.tenantName,
  role: m.role,
  suspended: m.tenantStatus !== "ACTIVE",
});

/** Pure resolution rules, given the session, the user's ACTIVE memberships and the cookie preference. */
export function resolveTenant(session: SessionState, memberships: MembershipRow[], preferredMembershipId: string | null, requestId: string): TenantResolution {
  if (session.state === "SIGNED_OUT") return { outcome: "SIGNED_OUT" };
  if (session.state === "NO_ACCOUNT") return { outcome: "NO_ACCOUNT" };
  if (session.state === "INACTIVE") return { outcome: "ACCOUNT_INACTIVE" };
  if (memberships.length === 0) return { outcome: "NO_MEMBERSHIP" };

  const summaries = memberships.map(summary);
  const usable = memberships.filter((m) => m.tenantStatus === "ACTIVE" && m.restaurant !== null);
  const preferred = preferredMembershipId ? memberships.find((m) => m.membershipId === preferredMembershipId) : undefined;

  // The user explicitly chose a restaurant that is now suspended: say so, and offer another if there is one.
  if (preferred && preferred.tenantStatus !== "ACTIVE") return { outcome: "SUSPENDED", canSwitch: usable.length > 0, memberships: summaries };
  if (usable.length === 0) return { outcome: "SUSPENDED", canSwitch: false, memberships: summaries };

  let chosen: MembershipRow | undefined;
  if (usable.length === 1) chosen = usable[0];
  else chosen = usable.find((m) => m.membershipId === preferred?.membershipId);
  if (!chosen) return { outcome: "SELECT_REQUIRED", memberships: summaries };

  const restaurant = chosen.restaurant!;
  return {
    outcome: "OK",
    memberships: summaries,
    ctx: {
      kind: "tenant",
      requestId,
      userId: session.user.id,
      membershipId: chosen.membershipId,
      tenantId: chosen.tenantId,
      role: chosen.role,
      // The role's permissions minus those of any feature switched off for this restaurant (RASOIOS-ADR-023).
      permissions: withoutDisabledFeatures(permissionsForTenantRole(chosen.role), chosen.disabledFeatures ?? []) as ReadonlySet<Permission>,
      disabledFeatures: new Set(chosen.disabledFeatures ?? []),
      restaurant: { id: restaurant.id, timezone: restaurant.timezone, currencyCode: restaurant.currencyCode },
    },
  };
}

export function resolvePlatform(session: SessionState, requestId: string): PlatformResolution {
  if (session.state === "SIGNED_OUT") return { outcome: "SIGNED_OUT" };
  if (session.state === "NO_ACCOUNT") return { outcome: "NO_ACCOUNT" };
  if (session.state === "INACTIVE") return { outcome: "ACCOUNT_INACTIVE" };
  if (session.user.platformRole !== "SUPER_ADMIN") return { outcome: "NOT_PLATFORM_ADMIN" };
  return {
    outcome: "OK",
    ctx: { kind: "platform", requestId, userId: session.user.id, permissions: permissionsForPlatformRole(session.user.platformRole) as ReadonlySet<Permission> },
  };
}

/** The request id set by the middleware (falls back when called outside a request, e.g. in scripts). */
export async function currentRequestId(): Promise<string> {
  try {
    return (await headers()).get("x-request-id") ?? crypto.randomUUID();
  } catch {
    return crypto.randomUUID();
  }
}

async function preferredMembershipFromCookie(): Promise<string | null> {
  try {
    return parseActiveMembershipCookie((await cookies()).get(ACTIVE_MEMBERSHIP_COOKIE)?.value);
  } catch {
    return null;
  }
}

/** Tenant context for this request (LD-AUTH-01 / every tenant loader, action and route handler). */
export const getTenantResolution = cache(async (): Promise<TenantResolution> => {
  const session = await getSessionUser();
  const requestId = await currentRequestId();
  const all = session.state === "ACTIVE" ? await activeMembershipsOfUser(session.user.id) : [];
  return resolveTenant(session, session.state === "ACTIVE" ? reachableBy(session, all) : all, await preferredMembershipFromCookie(), requestId);
});

/**
 * Which of a person's memberships the credential they used can actually reach (RASOIOS-ADR-019 §1).
 *
 * Counter staff do not use the identity provider at all: their administrator issues them a password each day, and
 * that password is the only way into a staff-role membership. So a Clerk session — an email one-time code — reaches
 * every membership *except* the staff ones, and a daily password reaches only the single membership it was issued
 * for.
 *
 * Filtering here rather than at sign-in keeps the rule true for people who hold both kinds of job. Someone who
 * manages one restaurant and waits tables at another signs in with Clerk and gets their manager console; the same
 * person signing in with that evening's password gets the waiter console, and neither credential quietly carries
 * the other's access.
 */
function reachableBy(session: Extract<SessionState, { state: "ACTIVE" }>, memberships: MembershipRow[]): MembershipRow[] {
  if (session.via === "STAFF_PASSWORD") return memberships.filter((m) => m.membershipId === session.membershipId);
  return memberships.filter((m) => !STAFF_ONLY_ROLES.has(m.role));
}

/** Roles that exist only behind a daily password. Mirrors `staff_sessions_role_is_staff_check` in the database. */
const STAFF_ONLY_ROLES = new Set<MembershipRow["role"]>(["CASHIER", "KITCHEN", "WAITER"]);

/** Platform (SUPER_ADMIN) context for this request. */
export const getPlatformResolution = cache(async (): Promise<PlatformResolution> => {
  return resolvePlatform(await getSessionUser(), await currentRequestId());
});

/**
 * LD-AUTH-01 display data for the console shell (S1-P05-T006). Call after `requireTenantPage(...)` with its context.
 * Contains the caller's own profile and restaurant only — never another tenant's data.
 */
export async function getConsoleSession(ctx: TenantContext): Promise<{
  user: { id: string; fullName: string | null; email: string };
  activeTenant: { name: string; slug: string; role: string; timezone: string; currencyCode: string; countryCode: string; logoUrl: string | null };
  membershipCount: number;
  capabilities: string[];
}> {
  const [session, memberships] = await Promise.all([getSessionUser(), activeMembershipsOfUser(ctx.userId)]);
  const active = memberships.find((m) => m.membershipId === ctx.membershipId);
  const user = session.state === "ACTIVE" ? session.user : null;
  return {
    user: { id: ctx.userId, fullName: user?.fullName ?? null, email: user?.email ?? "" },
    activeTenant: {
      name: active?.restaurant?.name ?? active?.tenantName ?? "",
      slug: active?.tenantSlug ?? "",
      role: ctx.role,
      timezone: ctx.restaurant.timezone,
      currencyCode: ctx.restaurant.currencyCode,
      countryCode: active?.restaurant?.countryCode ?? "",
      logoUrl: active?.restaurant?.logoUrl ?? null,
    },
    membershipCount: memberships.filter((m) => m.tenantStatus === "ACTIVE").length,
    capabilities: [...ctx.permissions],
  };
}
