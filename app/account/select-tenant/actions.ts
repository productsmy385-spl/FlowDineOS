"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth/guards";
import { ACTIVE_MEMBERSHIP_COOKIE, ACTIVE_MEMBERSHIP_COOKIE_OPTIONS } from "@/lib/auth/active-membership-cookie";
import { recordTenantSwitch } from "@/lib/data/session-switch";
import { activeMembershipsOfUser } from "@/lib/data/memberships";
import { NotFoundError } from "@/lib/errors";
import { action } from "@/lib/http/action";
import { parseInput, strictObject, uuidParam } from "@/lib/validation/core";

import { configuredRootDomain } from "@/lib/tenancy/request";

const switchSchema = strictObject({ membershipId: uuidParam });

/**
 * SA-AUTH-01 switchActiveTenantAction (S1-P04-T003, ADR-006 §3). Accepts only one of the caller's own ACTIVE
 * membership ids — never a tenant id. Anything else is NOT_FOUND (no oracle).
 */
export const switchActiveTenantAction = action(async (input: { membershipId: string }) => {
  const session = await requireSessionUser();
  const { membershipId } = parseInput(switchSchema, input);

  const memberships = await activeMembershipsOfUser(session.userId);
  const target = memberships.find((m) => m.membershipId === membershipId && m.tenantStatus === "ACTIVE" && m.restaurant);
  if (!target) throw new NotFoundError("Restaurant not found.");

  (await cookies()).set(ACTIVE_MEMBERSHIP_COOKIE, target.membershipId, ACTIVE_MEMBERSHIP_COOKIE_OPTIONS);
  await recordTenantSwitch({ userId: session.userId, tenantId: target.tenantId, membershipId: target.membershipId, role: target.role, requestId: session.requestId });
  const rootDomain = configuredRootDomain();
  const sub = target.subdomain || target.tenantSlug;
  if (sub && rootDomain && process.env.NODE_ENV !== "test") {
    redirect(`https://${sub}.${rootDomain}/restaurant/dashboard`);
  }
  redirect("/restaurant/dashboard");
});
