import "server-only";
import { redirect } from "next/navigation";
import {
  FeatureDisabledError,
  ForbiddenError,
  NoActiveMembershipError,
  TenantSelectionRequiredError,
  TenantSuspendedError,
  UnauthenticatedError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { FEATURES, featureOfPermission, type FeatureKey } from "./features";
import { currentRequestId, getPlatformResolution, getTenantResolution, type PlatformResolution, type TenantResolution } from "./context";
import type { PlatformContext, TenantContext } from "./context-types";
import { hasPermission, type PlatformPermission, type TenantPermission } from "./permissions";
import { getSessionUser } from "./session";

/**
 * Mandatory entry guards (S1-P04-T002/T004, security.md §1 steps 2–5, SC-AUTH-04, SC-RBAC-01).
 *
 * Every Server Action, Route Handler and loader calls exactly one of these *first*; the static test
 * `tests/static/guard-coverage.test.ts` enforces it. The permission is checked before any resource is loaded, so a
 * permission failure (403) can never reveal whether a resource exists.
 *
 * - `requireTenant` / `requirePlatform` — for actions and route handlers: throw typed errors (401/403/409).
 * - `requireTenantPage` / `requirePlatformPage` — for Server Components: redirect to the right account page.
 */

function tenantFailure(resolution: Exclude<TenantResolution, { outcome: "OK" }>): Error {
  switch (resolution.outcome) {
    case "SIGNED_OUT":
      return new UnauthenticatedError();
    case "SUSPENDED":
      return new TenantSuspendedError();
    case "SELECT_REQUIRED":
      return new TenantSelectionRequiredError();
    default:
      return new NoActiveMembershipError();
  }
}

function assertPermission(ctx: { permissions: ReadonlySet<string>; requestId: string; disabledFeatures?: ReadonlySet<string> }, permission: string): void {
  if (!hasPermission(ctx, permission)) {
    const feature = disabledFeatureFor(ctx, permission);
    logger.warn("security.forbidden", { requestId: ctx.requestId, permission, ...(feature ? { feature } : {}) });
    throw feature ? new FeatureDisabledError(FEATURES[feature].label) : new ForbiddenError();
  }
}

/** The switched-off feature that took this permission away, if that is why it is missing (RASOIOS-ADR-023). */
function disabledFeatureFor(ctx: { disabledFeatures?: ReadonlySet<string> }, permission: string): FeatureKey | null {
  const feature = featureOfPermission(permission);
  return feature && ctx.disabledFeatures?.has(feature) ? feature : null;
}

/** Re-checks a permission on an existing context (e.g. a second permission inside the same action). */
export function requirePermission(ctx: TenantContext | PlatformContext, permission: TenantPermission | PlatformPermission): void {
  assertPermission(ctx, permission);
}

export async function requireTenant(permission: TenantPermission): Promise<TenantContext> {
  const resolution = await getTenantResolution();
  if (resolution.outcome !== "OK") throw tenantFailure(resolution);
  assertPermission(resolution.ctx, permission);
  return resolution.ctx;
}

export async function requirePlatform(permission: PlatformPermission): Promise<PlatformContext> {
  const resolution = await getPlatformResolution();
  if (resolution.outcome === "SIGNED_OUT") throw new UnauthenticatedError();
  if (resolution.outcome !== "OK") {
    logger.warn("security.forbidden", { permission, reason: resolution.outcome });
    throw resolution.outcome === "NOT_PLATFORM_ADMIN" ? new ForbiddenError() : new NoActiveMembershipError();
  }
  assertPermission(resolution.ctx, permission);
  return resolution.ctx;
}

/** Where a page request goes when it cannot proceed. */
export function accountRedirectFor(resolution: Exclude<TenantResolution, { outcome: "OK" }> | Exclude<PlatformResolution, { outcome: "OK" }>): string {
  switch (resolution.outcome) {
    case "SIGNED_OUT":
      return "/sign-in";
    case "NO_ACCOUNT":
      return "/account/no-access?reason=NO_ACCOUNT";
    case "ACCOUNT_INACTIVE":
      return "/account/no-access?reason=ACCOUNT_INACTIVE";
    case "NO_MEMBERSHIP":
      return "/account/no-access?reason=NO_ACTIVE_MEMBERSHIP";
    case "SUSPENDED":
      return "/account/suspended";
    case "SELECT_REQUIRED":
      return "/account/select-tenant";
    case "NOT_PLATFORM_ADMIN":
      return "/account/forbidden";
  }
}

export async function requireTenantPage(permission: TenantPermission): Promise<TenantContext> {
  const resolution = await getTenantResolution();
  if (resolution.outcome !== "OK") redirect(accountRedirectFor(resolution));
  if (!hasPermission(resolution.ctx, permission)) {
    const feature = disabledFeatureFor(resolution.ctx, permission);
    logger.warn("security.forbidden", { requestId: resolution.ctx.requestId, permission, ...(feature ? { feature } : {}) });
    redirect(feature ? `/account/feature-disabled?feature=${feature}` : "/account/forbidden");
  }
  return resolution.ctx;
}

export async function requirePlatformPage(permission: PlatformPermission): Promise<PlatformContext> {
  const resolution = await getPlatformResolution();
  if (resolution.outcome !== "OK") redirect(accountRedirectFor(resolution));
  if (!hasPermission(resolution.ctx, permission)) redirect("/account/forbidden");
  return resolution.ctx;
}

/**
 * Session-only guard for account-level actions that run before a restaurant is chosen (e.g. SA-AUTH-01): the caller
 * must have an ACTIVE local account. No tenant permission applies.
 */
export async function requireSessionUser(): Promise<{ userId: string; requestId: string }> {
  const [session, requestId] = await Promise.all([getSessionUser(), currentRequestId()]);
  if (session.state === "SIGNED_OUT") throw new UnauthenticatedError();
  if (session.state !== "ACTIVE") throw new NoActiveMembershipError();
  return { userId: session.user.id, requestId };
}
