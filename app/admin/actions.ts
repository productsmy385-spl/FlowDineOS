"use server";

import { requirePlatform } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import {
  checkSlugAvailability,
  consumePlatformMutation,
  createTenant,
  handOverTenant,
  inviteTenantAdmin,
  reactivateTenant,
  revokeTenantAdminInvite,
  suspendTenant,
  updateTenant,
  updateTenantFeatures,
} from "@/lib/services/platform-tenants";
import { parseInput } from "@/lib/validation/core";
import {
  createTenantSchema,
  handOverTenantSchema,
  inviteTenantAdminSchema,
  reactivateTenantSchema,
  revokeTenantAdminInviteSchema,
  slugAvailabilitySchema,
  suspendTenantSchema,
  updateTenantSchema,
  type CreateTenantInput,
  type HandOverTenantInput,
  type InviteTenantAdminInput,
  type ReactivateTenantInput,
  type RevokeTenantAdminInviteInput,
  type SlugAvailabilityInput,
  type SuspendTenantInput,
  type UpdateTenantInput,
  updateTenantFeaturesSchema,
  type UpdateTenantFeaturesInput,
} from "@/lib/validation/platform";

/**
 * Platform console Server Actions (S1-P06-T001; api.md SA-ADM-01…06; security.md §3.3 rows 1–6).
 *
 * Order in every action: platform guard (SUPER_ADMIN + permission) before anything is read → `session.mutation` rate
 * limit (mutations) → strict input validation → service. Tenant roles are refused with FORBIDDEN by the guard. The target
 * tenant is `targetTenantId`, authorised by the platform role — platform actions have no tenant context (ADR-006).
 * Results use the ActionResult envelope (lib/http/action.ts).
 */

/** SA-ADM-01 — `platform:tenant:create`. `invitation.status = "FAILED"` is a warning: the tenant was created. */
export const createTenantAction = action(async (input: CreateTenantInput) => {
  const ctx = await requirePlatform("platform:tenant:create");
  await consumePlatformMutation(ctx);
  return createTenant(ctx, parseInput(createTenantSchema, input));
});

/** SlugField availability hint for the create and edit forms — `platform:tenant:read` (a metadata read). */
export const checkTenantSlugAction = action(async (input: SlugAvailabilityInput) => {
  const ctx = await requirePlatform("platform:tenant:read");
  return checkSlugAvailability(ctx, parseInput(slugAvailabilitySchema, input));
});

/** SA-ADM-02 — `platform:tenant:update`. The display name only: the slug is immutable (ADR-012 §4). */
export const updateTenantAction = action(async (input: UpdateTenantInput) => {
  const ctx = await requirePlatform("platform:tenant:update");
  await consumePlatformMutation(ctx);
  return updateTenant(ctx, parseInput(updateTenantSchema, input));
});

/** SA-ADM-07 — `platform:tenant:update`: records the handover to the restaurant's own administrator (ADR-013 §7). */
export const handOverTenantAction = action(async (input: HandOverTenantInput) => {
  const ctx = await requirePlatform("platform:tenant:update");
  await consumePlatformMutation(ctx);
  return handOverTenant(ctx, parseInput(handOverTenantSchema, input));
});

/** SA-ADM-03 — `platform:tenant:suspend`. Reason 10–500 characters. */
export const suspendTenantAction = action(async (input: SuspendTenantInput) => {
  const ctx = await requirePlatform("platform:tenant:suspend");
  await consumePlatformMutation(ctx);
  return suspendTenant(ctx, parseInput(suspendTenantSchema, input));
});

/** SA-ADM-04 — `platform:tenant:reactivate`. */
export const reactivateTenantAction = action(async (input: ReactivateTenantInput) => {
  const ctx = await requirePlatform("platform:tenant:reactivate");
  await consumePlatformMutation(ctx);
  return reactivateTenant(ctx, parseInput(reactivateTenantSchema, input));
});

/** SA-ADM-05 — `platform:tenant_admin:invite`. Re-inviting a pending administrator resends the invitation. */
export const inviteTenantAdminAction = action(async (input: InviteTenantAdminInput) => {
  const ctx = await requirePlatform("platform:tenant_admin:invite");
  await consumePlatformMutation(ctx);
  return inviteTenantAdmin(ctx, parseInput(inviteTenantAdminSchema, input));
});

/** SA-ADM-06 — `platform:tenant_admin:invite`. Only a pending TENANT_ADMIN invitation of the target tenant. */
export const revokeTenantAdminInviteAction = action(async (input: RevokeTenantAdminInviteInput) => {
  const ctx = await requirePlatform("platform:tenant_admin:invite");
  await consumePlatformMutation(ctx);
  return revokeTenantAdminInvite(ctx, parseInput(revokeTenantAdminInviteSchema, input));
});

/** SA-ADM-10 — `platform:tenant:update`: which features a restaurant has (RASOIOS-ADR-023). Audited. */
export const updateTenantFeaturesAction = action(async (input: UpdateTenantFeaturesInput) => {
  const ctx = await requirePlatform("platform:tenant:update");
  await consumePlatformMutation(ctx);
  return updateTenantFeatures(ctx, parseInput(updateTenantFeaturesSchema, input));
});
