import "server-only";
import type { TenantStatus } from "@prisma/client";
import { audit } from "@/lib/audit/write";
import { FEATURE_KEYS, FEATURES, type FeatureKey } from "@/lib/auth/features";
import { ClerkAdminError, clerkAdmin, maskEmail } from "@/lib/auth/clerk-admin";
import type { PlatformContext } from "@/lib/auth/context-types";
import { instantDto } from "@/lib/data/dto";
import {
  disabledFeaturesOf,
  writeFeatureSwitches,
  assertPlatform,
  countActiveTenantAdmins,
  createInvitee,
  deactivateInvitedMembership,
  findInvitee,
  handoverAuditAt,
  findMembershipOfUser,
  findTenantMembership,
  findTenantStatus,
  insertInvitedAdmin,
  insertTenantWithRestaurant,
  inspectPlatformTenant,
  isSlugTaken,
  lockTenant,
  markTenantActive,
  markTenantSuspended,
  membersLosingAllAccess,
  platformDashboard,
  platformTenantExists,
  recordAdminInvitation,
  reinviteAdmin,
  searchPlatformTenants,
  updateTenantIdentity,
  SlugTakenError,
  type Invitee,
  type PlatformDashboardData,
  type TargetMembership,
  type TenantInspection,
  type TenantListItem,
  type TenantProvisioningState,
} from "@/lib/data/platform-tenants";
import { withTx } from "@/lib/data/tx";
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { consumeScope } from "@/lib/security/rate-limit";
import { now } from "@/lib/time/clock";
import { SLUG_PATTERN, parseInput, uuidParam } from "@/lib/validation/core";
import {
  SLUG_RULE_MESSAGE,
  isReservedSlug,
  tenantListQuerySchema,
  type CreateTenantData,
  type HandOverTenantData,
  type InviteTenantAdminData,
  type SuspendTenantData,
  type TenantListQueryInput,
  type UpdateTenantData,
} from "@/lib/validation/platform";
import { appUrl } from "@/lib/env";

/**
 * Platform tenant services (S1-P06-T001; api.md LD-ADM-01…03, SA-ADM-01…06; security.md §3.3 rows 1–6, §7).
 *
 * - Every function takes a `PlatformContext` (a `TenantContext` is a type error) and re-checks its platform
 *   permission; the Server Action or page guard has already checked it before any input was read.
 * - Each state change and its audit row commit in one transaction (SC-AUD-02).
 * - Clerk (lib/auth/clerk-admin.ts contract): an invitation that local rows depend on is created *before* the local
 *   commit and revoked if the commit fails (SA-ADM-05); a revocation is made *before* the local change so a failure
 *   leaves nothing half-done (SA-ADM-06). Tenant creation is the documented exception (api.md SA-ADM-01): the tenant
 *   commits first and the invitation is sent after, so an identity-provider outage never blocks onboarding — the
 *   membership stays INVITED with no invitation on record and the result carries an INVITATION_FAILED warning.
 */

// ─── Errors ───

/**
 * 422: the slug is fixed at provisioning (ADR-012 §4, 2026-09-23). It is the restaurant's public address, printed on
 * QR codes and shared as a link, so renaming it is a platform operation with a redirect — Future Scope, not SLICE-01.
 * Supersedes the confirmed slug change of S1-P06-T001.
 */
export class SlugImmutableError extends ValidationError {
  constructor() {
    super("The website address can't be changed after the restaurant is created. Contact the platform owner if it has to move.", {
      slug: ["The website address is fixed when the restaurant is created"],
    });
    (this as { code: string }).code = "SLUG_IMMUTABLE";
  }
}

/** 409: handover needs a restaurant administrator who has accepted the invitation (ADR-013 §7). */
export class HandoverNotReadyError extends ConflictError {
  constructor() {
    super("Hand over once the restaurant's administrator has accepted the invitation and signed in.", "HANDOVER_NOT_READY");
  }
}

export { SlugTakenError };

function tenantNotFound(): NotFoundError {
  return new NotFoundError("Tenant not found");
}

// ─── Shared helpers ───

/** `session.mutation` budget (ADR-011 §2: 120/min per user on every Server Action). */
export async function consumePlatformMutation(ctx: PlatformContext): Promise<void> {
  const result = await consumeScope("session.mutation", ctx.userId);
  if (!result.allowed) throw new RateLimitedError(result.retryAfterSec);
}

/** Absolute sign-up URL for Clerk invitations, built only from server configuration (never from input). */
function invitationRedirectUrl(): string {
  const base = appUrl();
  if (!base || !/^https?:\/\/[^\s]+$/.test(base)) {
    // Server misconfiguration, not a user error: surfaces as INTERNAL with a request id, before anything is written.
    throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  }
  return new URL("/sign-up", base).toString();
}

/**
 * Who may be invited as a tenant administrator. A deactivated identity could never sign in again (ADR-006 §2), and a
 * SUPER_ADMIN may not take tenant access through a membership while support access is undecided (security.md §3.1,
 * Q-019) — both are refused rather than creating an invitation that cannot work or that bypasses that decision.
 */
function assertInvitable(user: Invitee | null): void {
  if (!user) return;
  if (user.status !== "ACTIVE") {
    throw new ConflictError("This person's account is deactivated, so they cannot be invited.", "USER_INACTIVE");
  }
  if (user.platformRole !== "NONE") {
    throw new ConflictError("A platform administrator cannot be invited into a restaurant. Use a different email address.", "PLATFORM_ADMIN_NOT_INVITABLE");
  }
}

/** An existing membership can take a TENANT_ADMIN invitation only if it is deactivated or already a pending TENANT_ADMIN invite. */
function assertMembershipInvitable(membership: TargetMembership | null): void {
  if (!membership) return;
  if (membership.status === "ACTIVE") throw new ConflictError("This person is already a member of this restaurant.", "ALREADY_MEMBER");
  if (membership.status === "INVITED" && membership.role !== "TENANT_ADMIN") {
    throw new ConflictError("This person already has a pending invitation to this restaurant with another role.", "ALREADY_MEMBER");
  }
}

export type InvitationOutcome =
  | { status: "SENT" }
  | { status: "FAILED"; code: "INVITATION_FAILED" | "CLERK_TIMEOUT"; message: string };

function failedInvitation(error: unknown): InvitationOutcome {
  if (error instanceof ClerkAdminError && error.code === "CLERK_TIMEOUT") {
    return { status: "FAILED", code: "CLERK_TIMEOUT", message: "The tenant was created, but the invitation email timed out. Resend the invitation." };
  }
  return { status: "FAILED", code: "INVITATION_FAILED", message: "The tenant was created, but the invitation email could not be sent. Resend the invitation." };
}

// ─── LD-ADM-01 platform dashboard ───

export async function getPlatformDashboard(ctx: PlatformContext): Promise<PlatformDashboardData> {
  assertPlatform(ctx, "platform:tenant:read");
  return platformDashboard(ctx);
}

// ─── LD-ADM-02 tenant list ───

export type TenantListPage = { items: TenantListItem[]; nextCursor: string | null };

type CursorPayload = { s: "name" | "createdAt"; id: string };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function invalidCursor(): ValidationError {
  return new ValidationError("This page link is no longer valid. Start again from the first page.", { cursor: ["Invalid cursor"] });
}

function decodeCursor(cursor: string, sort: CursorPayload["s"]): string {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const value = payload as Partial<CursorPayload> | null;
  if (!value || typeof value !== "object" || value.s !== sort || !uuidParam.safeParse(value.id).success) throw invalidCursor();
  return value.id as string;
}

/** Search by name/slug (escaped ILIKE), filter by status, sort by name (default) or newest, cursor-paginated. */
export async function listTenantsForPlatform(ctx: PlatformContext, input: TenantListQueryInput = {}): Promise<TenantListPage> {
  assertPlatform(ctx, "platform:tenant:read");
  const query = parseInput(tenantListQuerySchema, input);
  const afterId = query.cursor ? decodeCursor(query.cursor, query.sort) : undefined;
  if (afterId && !(await platformTenantExists(ctx, afterId))) throw invalidCursor();
  const page = await searchPlatformTenants(ctx, { q: query.q, status: query.status, sort: query.sort, afterId, limit: query.limit });
  return { items: page.items, nextCursor: page.hasMore && page.lastId ? encodeCursor({ s: query.sort, id: page.lastId }) : null };
}

// ─── LD-ADM-03 tenant inspection ───

/** Metadata, members, counts and lifecycle of one tenant; every view is audited (`platform.tenant_inspected`). */
export async function inspectTenant(ctx: PlatformContext, targetTenantId: string): Promise<TenantInspection> {
  assertPlatform(ctx, "platform:tenant:read");
  if (!uuidParam.safeParse(targetTenantId).success) throw tenantNotFound();
  const inspection = await inspectPlatformTenant(ctx, targetTenantId, now());
  if (!inspection) throw tenantNotFound();
  await withTx(ctx, (tx) =>
    audit(tx, ctx, { action: "platform.tenant_inspected", resourceType: "tenant", resourceId: inspection.tenant.id, tenantId: inspection.tenant.id }),
  );
  return inspection;
}

// ─── Slug availability hint (SlugField, frontend.md §5.2) ───

export type SlugAvailability = { slug: string; available: boolean; reason: "INVALID" | "RESERVED" | "TAKEN" | null; message: string | null };

export async function checkSlugAvailability(ctx: PlatformContext, input: { slug: string }, exceptTenantId?: string): Promise<SlugAvailability> {
  assertPlatform(ctx, "platform:tenant:read");
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return { slug, available: false, reason: "INVALID", message: SLUG_RULE_MESSAGE };
  if (isReservedSlug(slug)) return { slug, available: false, reason: "RESERVED", message: "This slug is reserved for the application. Choose another." };
  if (await isSlugTaken(ctx, slug, exceptTenantId)) return { slug, available: false, reason: "TAKEN", message: "This slug is already in use" };
  return { slug, available: true, reason: null, message: null };
}

// ─── SA-ADM-01 create tenant ───

export type CreateTenantResult = { tenantId: string; slug: string; membershipId: string; invitation: InvitationOutcome };

/**
 * TENANT + RESTAURANT (explicit timezone, currency, country — no silent defaults, Q-005) + closed hours + the first
 * TENANT_ADMIN as an INVITED membership, with `tenant.created` and `tenant_admin.invited`, in one transaction. The Clerk
 * invitation is sent after the commit; if it fails the tenant stays created and the invitation can be resent (SA-ADM-05).
 */
export async function createTenant(ctx: PlatformContext, data: CreateTenantData): Promise<CreateTenantResult> {
  assertPlatform(ctx, "platform:tenant:create");
  const redirectUrl = invitationRedirectUrl();
  const invitedAt = now();

  const created = await withTx(ctx, async (tx) => {
    const { tenantId } = await insertTenantWithRestaurant(ctx, tx, {
      tenantName: data.tenantName,
      slug: data.slug,
      restaurantName: data.restaurantName,
      timezone: data.timezone,
      currencyCode: data.currencyCode,
      countryCode: data.countryCode,
    });
    const existing = await findInvitee(ctx, data.adminEmail, tx);
    assertInvitable(existing);
    const invitee = existing ?? (await createInvitee(ctx, tx, data.adminEmail, data.adminFullName));
    const membership = await insertInvitedAdmin(ctx, tx, { tenantId, userId: invitee.id, invitedAt, clerkInvitationId: null });
    // Features chosen at creation (RASOIOS-ADR-023); left out, the restaurant starts with every feature on.
    const disabled = data.enabledFeatures ? FEATURE_KEYS.filter((key) => !data.enabledFeatures!.includes(key)) : [];
    if (disabled.length > 0) await writeFeatureSwitches(ctx, tx, tenantId, Object.fromEntries(disabled.map((key) => [key, false])));

    await audit(tx, ctx, {
      action: "tenant.created",
      resourceType: "tenant",
      resourceId: tenantId,
      tenantId,
      after: {
        name: data.tenantName,
        slug: data.slug,
        status: "ACTIVE",
        restaurant: { name: data.restaurantName, timezone: data.timezone, currencyCode: data.currencyCode, countryCode: data.countryCode },
        hours: "CLOSED_ALL_WEEK",
        disabledFeatures: data.enabledFeatures ? FEATURE_KEYS.filter((key) => !data.enabledFeatures!.includes(key)) : [],
      },
    });
    await audit(tx, ctx, {
      action: "tenant_admin.invited",
      resourceType: "user_tenant",
      resourceId: membership.id,
      tenantId,
      after: { role: "TENANT_ADMIN", status: "INVITED", email: invitee.email, newUser: existing === null },
    });
    return { tenantId, membershipId: membership.id };
  });

  const invitation = await sendInvitationAfterCommit(ctx, created.tenantId, created.membershipId, data.adminEmail, redirectUrl);
  return { tenantId: created.tenantId, slug: data.slug, membershipId: created.membershipId, invitation };
}

/**
 * Sends the Clerk invitation for a membership that is already committed as INVITED and records its id. Never throws:
 * any failure is a warning, because the tenant exists and the invitation can be resent. If the id cannot be recorded
 * the invitation is revoked again, so Clerk never holds an invitation the database does not know about.
 */
async function sendInvitationAfterCommit(ctx: PlatformContext, tenantId: string, membershipId: string, email: string, redirectUrl: string): Promise<InvitationOutcome> {
  const clerk = clerkAdmin();
  let invitationId: string;
  try {
    ({ invitationId } = await clerk.createInvitation(email, redirectUrl));
  } catch (error) {
    logger.warn("platform.invitation_failed", { requestId: ctx.requestId, tenantId, membershipId, email: maskEmail(email), code: (error as { code?: string }).code });
    return failedInvitation(error);
  }
  try {
    if (!(await recordAdminInvitation(ctx, tenantId, membershipId, invitationId))) throw new Error("membership is no longer pending");
    return { status: "SENT" };
  } catch (error) {
    logger.error("platform.invitation_not_recorded", { requestId: ctx.requestId, tenantId, membershipId, error: error instanceof Error ? error.message : String(error) });
    await clerk.revokeInvitation(invitationId).catch((revokeError: unknown) =>
      logger.error("platform.invitation_compensation_failed", { requestId: ctx.requestId, tenantId, membershipId, code: (revokeError as { code?: string }).code }),
    );
    return failedInvitation(error);
  }
}

// ─── SA-ADM-02 update tenant ───

export type UpdateTenantResult = { tenantId: string; name: string; slug: string; changed: boolean };

/** New display name only. Sending the current slug is a no-op; a different one is refused (ADR-012 §4). */
export async function updateTenant(ctx: PlatformContext, data: UpdateTenantData): Promise<UpdateTenantResult> {
  assertPlatform(ctx, "platform:tenant:update");
  return withTx(ctx, async (tx) => {
    const tenant = await lockTenant(ctx, tx, data.targetTenantId);
    if (!tenant) throw tenantNotFound();

    const changes: { name?: string } = {};
    const before: { name?: string } = {};
    if (data.name !== undefined && data.name !== tenant.name) {
      changes.name = data.name;
      before.name = tenant.name;
    }
    if (data.slug !== undefined && data.slug !== tenant.slug) throw new SlugImmutableError();
    if (Object.keys(changes).length === 0) return { tenantId: tenant.id, name: tenant.name, slug: tenant.slug, changed: false };

    await updateTenantIdentity(ctx, tx, tenant.id, changes);
    await audit(tx, ctx, { action: "tenant.updated", resourceType: "tenant", resourceId: tenant.id, tenantId: tenant.id, before, after: changes });
    return { tenantId: tenant.id, name: changes.name ?? tenant.name, slug: tenant.slug, changed: true };
  });
}

// ─── SA-ADM-07 handover (S1-P06-T009, ADR-013 §7) ───

export type HandOverTenantResult = { tenantId: string; provisioningState: TenantProvisioningState; handedOverAt: string; alreadyHandedOver: boolean };

/**
 * Records that the restaurant has been handed to its own administrator: from here the TENANT_ADMIN runs the
 * restaurant, its website, menu, staff and printers, and the platform keeps metadata access only. Handover needs an
 * administrator who has accepted the invitation, is idempotent (a second call writes nothing and reports the first
 * handover), and is written as an append-only `tenant.handed_over` audit row — the state itself (ADR-013 §7).
 */
export async function handOverTenant(ctx: PlatformContext, data: HandOverTenantData): Promise<HandOverTenantResult> {
  assertPlatform(ctx, "platform:tenant:update");
  return withTx(ctx, async (tx) => {
    const tenant = await lockTenant(ctx, tx, data.targetTenantId);
    if (!tenant) throw tenantNotFound();

    const existing = await handoverAuditAt(ctx, tenant.id, tx);
    if (existing !== null) {
      return { tenantId: tenant.id, provisioningState: "HANDED_OVER", handedOverAt: instantDto(existing), alreadyHandedOver: true };
    }
    if ((await countActiveTenantAdmins(ctx, tenant.id, tx)) === 0) throw new HandoverNotReadyError();

    await audit(tx, ctx, {
      action: "tenant.handed_over",
      resourceType: "tenant",
      resourceId: tenant.id,
      tenantId: tenant.id,
      reason: data.note,
      after: { provisioningState: "HANDED_OVER", slug: tenant.slug },
    });
    // Read the committed row back so the reported instant is the audit row's own timestamp, not the request clock.
    const written = await handoverAuditAt(ctx, tenant.id, tx);
    return { tenantId: tenant.id, provisioningState: "HANDED_OVER", handedOverAt: instantDto(written ?? now()), alreadyHandedOver: false };
  });
}

// ─── SA-ADM-03 suspend / SA-ADM-04 reactivate ───

export type SessionRevocationSummary = { usersSignedOut: number; failures: number };
export type SuspendTenantResult = { tenantId: string; status: TenantStatus; suspendedAt: string; sessions: SessionRevocationSummary };

/**
 * Suspends the tenant: staff are refused on their next request (the context resolver reads tenant status every
 * request, ADR-006 §4) and the public site returns 404. After the commit, members left with no usable restaurant are
 * also signed out of Clerk (SC-AUTH-08); that is defence in depth, so a Clerk failure is logged, never undone.
 */
export async function suspendTenant(ctx: PlatformContext, data: SuspendTenantData): Promise<SuspendTenantResult> {
  assertPlatform(ctx, "platform:tenant:suspend");
  const at = now();
  const tenantId = await withTx(ctx, async (tx) => {
    const tenant = await lockTenant(ctx, tx, data.targetTenantId);
    if (!tenant) throw tenantNotFound();
    if (tenant.status === "SUSPENDED") throw new ConflictError("This tenant is already suspended.", "ALREADY_SUSPENDED");
    await markTenantSuspended(ctx, tx, tenant.id, data.reason, at);
    await audit(tx, ctx, {
      action: "tenant.suspended",
      resourceType: "tenant",
      resourceId: tenant.id,
      tenantId: tenant.id,
      reason: data.reason,
      before: { status: tenant.status },
      after: { status: "SUSPENDED", suspendedAt: at.toISOString() },
    });
    return tenant.id;
  });
  const sessions = await signOutMembersWithoutAccess(ctx, tenantId);
  return { tenantId, status: "SUSPENDED", suspendedAt: at.toISOString(), sessions };
}

async function signOutMembersWithoutAccess(ctx: PlatformContext, tenantId: string): Promise<SessionRevocationSummary> {
  const summary: SessionRevocationSummary = { usersSignedOut: 0, failures: 0 };
  let targets: Array<{ userId: string; clerkUserId: string }>;
  try {
    targets = await membersLosingAllAccess(ctx, tenantId);
  } catch (error) {
    logger.error("platform.session_revocation_lookup_failed", { requestId: ctx.requestId, tenantId, error: error instanceof Error ? error.message : String(error) });
    return { usersSignedOut: 0, failures: 1 };
  }
  const clerk = clerkAdmin();
  for (const target of targets) {
    try {
      await clerk.revokeUserSessions(target.clerkUserId);
      summary.usersSignedOut += 1;
    } catch (error) {
      summary.failures += 1;
      logger.warn("platform.session_revocation_failed", { requestId: ctx.requestId, tenantId, userId: target.userId, code: (error as { code?: string }).code });
    }
  }
  return summary;
}

export type ReactivateTenantResult = { tenantId: string; status: TenantStatus };

export async function reactivateTenant(ctx: PlatformContext, data: { targetTenantId: string }): Promise<ReactivateTenantResult> {
  assertPlatform(ctx, "platform:tenant:reactivate");
  return withTx(ctx, async (tx) => {
    const tenant = await lockTenant(ctx, tx, data.targetTenantId);
    if (!tenant) throw tenantNotFound();
    if (tenant.status !== "SUSPENDED") throw new ConflictError("This tenant is not suspended.", "NOT_SUSPENDED");
    await markTenantActive(ctx, tx, tenant.id);
    await audit(tx, ctx, {
      action: "tenant.reactivated",
      resourceType: "tenant",
      resourceId: tenant.id,
      tenantId: tenant.id,
      before: { status: tenant.status, suspendedAt: tenant.suspendedAt?.toISOString() ?? null },
      after: { status: "ACTIVE" },
    });
    return { tenantId: tenant.id, status: "ACTIVE" as const };
  });
}

// ─── SA-ADM-05 invite / resend tenant administrator ───

export type InviteTenantAdminResult = { tenantId: string; membershipId: string; resent: boolean; invitation: { status: "SENT" } };

/**
 * USER (if new) + INVITED TENANT_ADMIN membership + Clerk invitation. Re-inviting a pending TENANT_ADMIN resends
 * (new invitation, previous one revoked); a deactivated membership becomes a new invitation. The Clerk invitation is
 * created before the local commit and revoked if the commit fails, so a failure on either side changes nothing.
 */
export async function inviteTenantAdmin(ctx: PlatformContext, data: InviteTenantAdminData): Promise<InviteTenantAdminResult> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  const tenant = await findTenantStatus(ctx, data.targetTenantId);
  if (!tenant) throw tenantNotFound();
  const redirectUrl = invitationRedirectUrl();

  // Refuse before contacting Clerk when the outcome is already known.
  const known = await findInvitee(ctx, data.email);
  assertInvitable(known);
  assertMembershipInvitable(known ? await findMembershipOfUser(ctx, tenant.id, known.id) : null);

  const clerk = clerkAdmin();
  const { invitationId } = await clerk.createInvitation(data.email, redirectUrl);

  let saved: { membershipId: string; resent: boolean; previousInvitationId: string | null };
  try {
    saved = await withTx(ctx, async (tx) => {
      if (!(await lockTenant(ctx, tx, tenant.id))) throw tenantNotFound();
      const existing = await findInvitee(ctx, data.email, tx);
      assertInvitable(existing);
      const invitee = existing ?? (await createInvitee(ctx, tx, data.email, data.fullName));
      const membership = existing ? await findMembershipOfUser(ctx, tenant.id, invitee.id, tx) : null;
      assertMembershipInvitable(membership);

      const invitedAt = now();
      const row = membership
        ? await reinviteAdmin(ctx, tx, { tenantId: tenant.id, membershipId: membership.id, invitedAt, clerkInvitationId: invitationId })
        : await insertInvitedAdmin(ctx, tx, { tenantId: tenant.id, userId: invitee.id, invitedAt, clerkInvitationId: invitationId });
      const resent = membership?.status === "INVITED";
      await audit(tx, ctx, {
        action: "tenant_admin.invited",
        resourceType: "user_tenant",
        resourceId: row.id,
        tenantId: tenant.id,
        before: membership ? { status: membership.status, role: membership.role } : null,
        after: { status: "INVITED", role: "TENANT_ADMIN", email: invitee.email, resent, newUser: existing === null },
      });
      return { membershipId: row.id, resent, previousInvitationId: membership?.clerkInvitationId ?? null };
    });
  } catch (error) {
    await clerk.revokeInvitation(invitationId).catch((revokeError: unknown) =>
      logger.error("platform.invitation_compensation_failed", { requestId: ctx.requestId, tenantId: tenant.id, code: (revokeError as { code?: string }).code }),
    );
    throw error;
  }

  if (saved.previousInvitationId && saved.previousInvitationId !== invitationId) {
    // The superseded link should stop working; failing to revoke it is logged, not fatal (the newest invite is on record).
    await clerk.revokeInvitation(saved.previousInvitationId).catch((error: unknown) =>
      logger.warn("platform.previous_invitation_not_revoked", { requestId: ctx.requestId, tenantId: tenant.id, code: (error as { code?: string }).code }),
    );
  }
  return { tenantId: tenant.id, membershipId: saved.membershipId, resent: saved.resent, invitation: { status: "SENT" } };
}

// ─── SA-ADM-06 revoke a pending tenant administrator invitation ───

export type RevokeTenantAdminInviteResult = { tenantId: string; membershipId: string; status: "INACTIVE" };

/** Revokes the Clerk invitation first (a failure changes nothing locally), then marks the membership INACTIVE. */
export async function revokeTenantAdminInvite(ctx: PlatformContext, data: { targetTenantId: string; membershipId: string }): Promise<RevokeTenantAdminInviteResult> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  const membership = await findTenantMembership(ctx, data.targetTenantId, data.membershipId);
  if (!membership) throw new NotFoundError("Invitation not found");
  if (membership.role !== "TENANT_ADMIN") {
    throw new ConflictError("Only pending Tenant Admin invitations can be revoked from the platform console.", "NOT_TENANT_ADMIN_INVITE");
  }
  if (membership.status !== "INVITED") throw new ConflictError("This invitation is no longer pending.", "NOT_INVITED");

  if (membership.clerkInvitationId) await clerkAdmin().revokeInvitation(membership.clerkInvitationId);

  const at = now();
  await withTx(ctx, async (tx) => {
    if (!(await deactivateInvitedMembership(ctx, tx, membership.tenantId, membership.id, at))) {
      throw new ConflictError("This invitation is no longer pending.", "NOT_INVITED");
    }
    await audit(tx, ctx, {
      action: "tenant_admin.invite_revoked",
      resourceType: "user_tenant",
      resourceId: membership.id,
      tenantId: membership.tenantId,
      before: { status: "INVITED", role: membership.role },
      after: { status: "INACTIVE" },
    });
  });
  return { tenantId: membership.tenantId, membershipId: membership.id, status: "INACTIVE" };
}

// ─── Feature switches (RASOIOS-ADR-023) ───

export type TenantFeatureView = { key: FeatureKey; label: string; description: string; enabled: boolean };

export async function getTenantFeatures(ctx: PlatformContext, targetTenantId: string): Promise<TenantFeatureView[]> {
  assertPlatform(ctx, "platform:tenant:read");
  if (!(await platformTenantExists(ctx, targetTenantId))) throw new NotFoundError("Tenant not found");
  const off = new Set(await disabledFeaturesOf(ctx, targetTenantId));
  return FEATURE_KEYS.map((key) => ({ key, label: FEATURES[key].label, description: FEATURES[key].description, enabled: !off.has(key) }));
}

/**
 * SA-ADM-10 — turns features on or off for one restaurant. Takes effect on that restaurant's next request (sessions
 * re-read permissions every request). Audited with exactly what changed.
 */
export async function updateTenantFeatures(ctx: PlatformContext, data: { targetTenantId: string; enabled: FeatureKey[] }): Promise<TenantFeatureView[]> {
  assertPlatform(ctx, "platform:tenant:update");
  if (!(await platformTenantExists(ctx, data.targetTenantId))) throw new NotFoundError("Tenant not found");
  await withTx(ctx, async (tx) => {
    const before = new Set(await disabledFeaturesOf(ctx, data.targetTenantId, tx));
    const wanted = new Set(data.enabled);
    const switches = Object.fromEntries(FEATURE_KEYS.map((key) => [key, wanted.has(key)]));
    const changed = FEATURE_KEYS.filter((key) => before.has(key) === wanted.has(key));
    if (changed.length === 0) return;
    await writeFeatureSwitches(ctx, tx, data.targetTenantId, switches);
    await audit(tx, ctx, {
      action: "tenant.features_updated",
      resourceType: "tenant",
      resourceId: data.targetTenantId,
      tenantId: data.targetTenantId,
      before: Object.fromEntries(changed.map((key) => [key, before.has(key) ? "disabled" : "enabled"])),
      after: Object.fromEntries(changed.map((key) => [key, wanted.has(key) ? "enabled" : "disabled"])),
    });
  });
  return getTenantFeatures(ctx, data.targetTenantId);
}
