import "server-only";
import { Prisma, type AuditActorType, type MembershipStatus, type PlatformRole, type TenantRole, type TenantStatus, type UserStatus } from "@prisma/client";
import type { PlatformContext } from "@/lib/auth/context-types";
import { hasPermission, type PlatformPermission } from "@/lib/auth/permissions";
import { db } from "@/lib/db/prisma";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { PLATFORM_AUDIT_WHERE } from "./audit";
import { instantDto, nullableInstantDto } from "./dto";
import { mapErrors } from "./errors";
import { likeLiteral } from "./search";
import type { Tx } from "./tx";
import { defaultSectionRows } from "./website";

/**
 * Platform tenant data access (S1-P04-T008 interim reads; S1-P06-T001 lifecycle, LD-ADM-01…03, SA-ADM-01…06).
 *
 * SUPER_ADMIN reads tenant METADATA only — name, slug, status, dates, restaurant summary, members and counts — never a
 * tenant's orders, customers, transactions or menu rows (security.md §3.3 rows 1–7: "platform = all tenants, metadata
 * only"; SC-RBAC-07, SC-TEN-08). TENANT is the root entity, so tenant reads span all tenants by design. Queries on
 * tenant-owned tables either filter by the *target* tenant id (authorised by the platform role, api.md §3) or carry a
 * `tenant-scope-exempt` justification. Every function takes a `PlatformContext` and re-checks the platform permission
 * as defence in depth; a `TenantContext` is a type error.
 */

// ─── Authorization (defence in depth; the entry guard already checked) ───

export function assertPlatform(ctx: PlatformContext, permission: PlatformPermission): void {
  if (ctx?.kind !== "platform" || !hasPermission(ctx, permission)) throw new ForbiddenError();
}

function assertPlatformTenantRead(ctx: PlatformContext): void {
  assertPlatform(ctx, "platform:tenant:read");
}

// ─── Errors specific to tenant identity ───

/** 422 SLUG_TAKEN (api.md SA-ADM-01/02): another tenant already uses the slug. */
export class SlugTakenError extends ValidationError {
  constructor() {
    super("This slug is already in use. Choose another.", { slug: ["This slug is already in use"] });
    (this as { code: string }).code = "SLUG_TAKEN";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ─── LD-ADM-01 platform dashboard ───

export type PlatformAuditRow = {
  id: string;
  action: string;
  /** The tenant the event concerns; null for platform-level events. */
  tenantId: string | null;
  tenantName: string | null;
  actorType: AuditActorType;
  actorRole: string | null;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
};

export type RecentTenant = { id: string; name: string; slug: string; status: TenantStatus; createdAt: string };

export type PlatformDashboardData = {
  tenantCounts: { active: number; suspended: number };
  recentTenants: RecentTenant[];
  /** Empty unless the caller also holds `platform:audit:read`. */
  recentPlatformAudit: PlatformAuditRow[];
};

/** The newest platform-visible audit rows (requires `platform:audit:read`). */
export async function recentPlatformAudit(ctx: PlatformContext, take = 10): Promise<PlatformAuditRow[]> {
  assertPlatform(ctx, "platform:audit:read");
  const rows = await mapErrors("Audit log", () =>
    // tenant-scope-exempt: SUPER_ADMIN platform audit — platform-level rows and tenant lifecycle rows only (LD-ADM-01/04, SC-AUD-05)
    db.auditLog.findMany({
      where: PLATFORM_AUDIT_WHERE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        action: true,
        tenantId: true,
        actorType: true,
        actorRole: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
        tenant: { select: { name: true } },
      },
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    tenantId: row.tenantId,
    tenantName: row.tenant?.name ?? null,
    actorType: row.actorType,
    actorRole: row.actorRole,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    createdAt: instantDto(row.createdAt),
  }));
}

export async function platformDashboard(ctx: PlatformContext, recent = 10): Promise<PlatformDashboardData> {
  assertPlatformTenantRead(ctx);
  const [active, suspended, tenants, audit] = await Promise.all([
    mapErrors("Tenant", () => db.tenant.count({ where: { status: "ACTIVE" } })),
    mapErrors("Tenant", () => db.tenant.count({ where: { status: "SUSPENDED" } })),
    mapErrors("Tenant", () =>
      db.tenant.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: recent,
        select: { id: true, name: true, slug: true, status: true, createdAt: true },
      }),
    ),
    hasPermission(ctx, "platform:audit:read") ? recentPlatformAudit(ctx, recent) : Promise.resolve<PlatformAuditRow[]>([]),
  ]);
  return {
    tenantCounts: { active, suspended },
    recentTenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, createdAt: instantDto(t.createdAt) })),
    recentPlatformAudit: audit,
  };
}

// ─── LD-ADM-02 tenant list ───

export type TenantListItem = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  createdAt: string;
  /** ACTIVE memberships (invited and deactivated people are not counted). */
  memberCount: number;
  websitePublished: boolean;
};

export type TenantSearch = {
  q?: string;
  status?: TenantStatus;
  sort: "name" | "createdAt";
  /** Id of the last row of the previous page (keyset cursor). */
  afterId?: string;
  limit: number;
};

/**
 * One page of tenants. Keyset pagination anchored on the previous page's last row: Prisma's cursor compares the stored
 * sort values of that row (full microsecond precision), and the anchor row itself is dropped whether or not it still
 * matches the filters — so a tenant changing status between pages never shifts or skips rows.
 */
export async function searchPlatformTenants(ctx: PlatformContext, search: TenantSearch): Promise<{ items: TenantListItem[]; lastId: string | null; hasMore: boolean }> {
  assertPlatformTenantRead(ctx);
  const q = search.q?.trim();
  const where: Prisma.TenantWhereInput = {
    ...(search.status ? { status: search.status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: likeLiteral(q), mode: "insensitive" } },
            { slug: { contains: likeLiteral(q.toLowerCase()), mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.TenantOrderByWithRelationInput[] =
    search.sort === "createdAt" ? [{ createdAt: "desc" }, { id: "desc" }] : [{ name: "asc" }, { id: "asc" }];

  const rows = await mapErrors("Tenant", () =>
    db.tenant.findMany({
      where,
      orderBy,
      take: search.limit + 2,
      ...(search.afterId ? { cursor: { id: search.afterId } } : {}),
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        restaurant: { select: { websitePublished: true } },
        _count: { select: { memberships: { where: { status: "ACTIVE" } } } },
      },
    }),
  );
  const afterAnchor = search.afterId ? rows.filter((row) => row.id !== search.afterId) : rows;
  const page = afterAnchor.slice(0, search.limit);
  return {
    items: page.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: instantDto(t.createdAt),
      memberCount: t._count.memberships,
      websitePublished: t.restaurant?.websitePublished ?? false,
    })),
    lastId: page.length ? page[page.length - 1].id : null,
    hasMore: afterAnchor.length > search.limit,
  };
}

/** True when a tenant row exists (used to validate an opaque list cursor). */
export async function platformTenantExists(ctx: PlatformContext, tenantId: string): Promise<boolean> {
  assertPlatformTenantRead(ctx);
  const row = await mapErrors("Tenant", () => db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }));
  return row !== null;
}

// ─── LD-ADM-03 tenant inspection ───

export type TenantMemberRow = {
  membershipId: string;
  fullName: string | null;
  email: string;
  role: TenantRole;
  status: MembershipStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  /** For INVITED rows: whether a Clerk invitation is on record (false after an INVITATION_FAILED; resend it). */
  invitationSent: boolean;
};

export type TenantLifecycleEvent = { id: string; action: string; actorRole: string | null; reason: string | null; createdAt: string };

/** Provisioning vs handed-over (S1-P06-T009): `PROVISIONING` until the Super Admin records the handover. */
export type TenantProvisioningState = "PROVISIONING" | "HANDED_OVER";

export type TenantInspection = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: TenantStatus;
    suspendedAt: string | null;
    suspensionReason: string | null;
    createdAt: string;
    provisioningState: TenantProvisioningState;
    handedOverAt: string | null;
  };
  restaurant: { name: string; timezone: string; currencyCode: string; websitePublished: boolean; city: string | null; countryCode: string } | null;
  members: TenantMemberRow[];
  counts: { menuItems: number; ordersLast30Days: number; printAgentsActive: number };
  lifecycle: TenantLifecycleEvent[];
};

/** Lifecycle actions shown on the inspection page (security.md §7 Platform domain, minus the inspection log itself). */
export const TENANT_LIFECYCLE_ACTIONS = [
  "tenant.created",
  "tenant.updated",
  "tenant.suspended",
  "tenant.reactivated",
  "tenant.handed_over",
  "tenant_admin.invited",
  "tenant_admin.invite_revoked",
];

/**
 * Metadata, members and counts of one tenant — counts only for operational data: no order, customer, transaction or
 * menu row ever leaves this function (SC-RBAC-07, TC-ADMIN-006). Null when the tenant does not exist.
 */
export async function inspectPlatformTenant(ctx: PlatformContext, tenantId: string, at: Date): Promise<TenantInspection | null> {
  assertPlatformTenantRead(ctx);
  const tenant = await mapErrors("Tenant", () =>
    db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        suspendedAt: true,
        suspensionReason: true,
        createdAt: true,
        restaurant: { select: { name: true, timezone: true, currencyCode: true, websitePublished: true, city: true, countryCode: true } },
      },
    }),
  );
  if (!tenant) return null;

  const since = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000);
  const handedOverAt = await handoverAuditAt(ctx, tenant.id);
  const [members, menuItems, ordersLast30Days, printAgentsActive, lifecycle] = await mapErrors("Tenant", () =>
    Promise.all([
      db.userTenant.findMany({
        where: { tenantId: tenant.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          role: true,
          status: true,
          invitedAt: true,
          acceptedAt: true,
          clerkInvitationId: true,
          user: { select: { fullName: true, email: true } },
        },
      }),
      db.menuItem.count({ where: { tenantId: tenant.id, archivedAt: null } }),
      db.order.count({ where: { tenantId: tenant.id, createdAt: { gte: since } } }),
      db.printAgent.count({ where: { tenantId: tenant.id, status: "ACTIVE" } }),
      db.auditLog.findMany({
        where: { tenantId: tenant.id, action: { in: TENANT_LIFECYCLE_ACTIONS } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: { id: true, action: true, actorRole: true, reason: true, createdAt: true },
      }),
    ]),
  );

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      suspendedAt: nullableInstantDto(tenant.suspendedAt),
      suspensionReason: tenant.suspensionReason,
      createdAt: instantDto(tenant.createdAt),
      provisioningState: handedOverAt === null ? "PROVISIONING" : "HANDED_OVER",
      handedOverAt: nullableInstantDto(handedOverAt),
    },
    restaurant: tenant.restaurant
      ? {
          name: tenant.restaurant.name,
          timezone: tenant.restaurant.timezone,
          currencyCode: tenant.restaurant.currencyCode,
          websitePublished: tenant.restaurant.websitePublished,
          city: tenant.restaurant.city,
          countryCode: tenant.restaurant.countryCode,
        }
      : null,
    members: members.map((m) => ({
      membershipId: m.id,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role,
      status: m.status,
      invitedAt: nullableInstantDto(m.invitedAt),
      acceptedAt: nullableInstantDto(m.acceptedAt),
      invitationSent: m.clerkInvitationId !== null,
    })),
    counts: { menuItems, ordersLast30Days, printAgentsActive },
    lifecycle: lifecycle.map((e) => ({ id: e.id, action: e.action, actorRole: e.actorRole, reason: e.reason, createdAt: instantDto(e.createdAt) })),
  };
}

// ─── Slugs ───

/** True when another tenant (not `exceptTenantId`) already has this slug. */
export async function isSlugTaken(ctx: PlatformContext, slug: string, exceptTenantId?: string, client: Tx = db): Promise<boolean> {
  assertPlatformTenantRead(ctx);
  const row = await mapErrors("Tenant", () => client.tenant.findUnique({ where: { slug }, select: { id: true } }));
  return row !== null && row.id !== exceptTenantId;
}

// ─── SA-ADM-01 create tenant (inside the caller's transaction) ───

export type NewTenantRows = {
  tenantName: string;
  slug: string;
  restaurantName: string;
  timezone: string;
  currencyCode: string;
  countryCode: string;
};

/**
 * TENANT + RESTAURANT + seven closed RESTAURANT_HOURS rows (the tenant administrator sets real hours later)
 * + the default WEBSITE_SECTION layout and the PLATFORM theme, so the restaurant's public site is complete the moment
 * it is published and before anyone edits it (S1-P06-T009, ADR-013 §6). A slug collision — including one that races
 * the pre-check — is a 422 SLUG_TAKEN.
 */
export async function insertTenantWithRestaurant(ctx: PlatformContext, tx: Tx, rows: NewTenantRows): Promise<{ tenantId: string; restaurantId: string }> {
  assertPlatform(ctx, "platform:tenant:create");
  if (await isSlugTaken(ctx, rows.slug, undefined, tx)) throw new SlugTakenError();
  let tenantId: string;
  try {
    ({ id: tenantId } = await tx.tenant.create({
      data: { name: rows.tenantName, slug: rows.slug, status: "ACTIVE", createdByUserId: ctx.userId },
      select: { id: true },
    }));
  } catch (error) {
    if (isUniqueViolation(error)) throw new SlugTakenError();
    throw error;
  }
  const restaurant = await tx.restaurant.create({
    data: {
      tenantId,
      name: rows.restaurantName,
      timezone: rows.timezone,
      currencyCode: rows.currencyCode,
      countryCode: rows.countryCode,
      themePreset: "PLATFORM",
      themeSurfaceMode: "DARK",
    },
    select: { id: true },
  });
  await tx.restaurantHours.createMany({
    data: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ tenantId, restaurantId: restaurant.id, dayOfWeek, sequence: 1, isClosed: true, opensAt: null, closesAt: null })),
  });
  await tx.websiteSection.createMany({ data: defaultSectionRows(tenantId, restaurant.id) });
  return { tenantId, restaurantId: restaurant.id };
}

// ─── SA-ADM-07 handover (S1-P06-T009) ───

/**
 * Handover is a milestone, not a column: a tenant is "handed over" once a `tenant.handed_over` row exists in the
 * append-only audit trail (ADR-013 §7). This keeps the record immutable and needs no schema change.
 */
export async function handoverAuditAt(ctx: PlatformContext, tenantId: string, client: Tx = db): Promise<Date | null> {
  assertPlatformTenantRead(ctx);
  const row = await mapErrors("Tenant", () =>
    // tenant-scope-exempt: platform metadata read of the *target* tenant, authorised by the platform role (api.md §3).
    client.auditLog.findFirst({ where: { tenantId, action: "tenant.handed_over" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  );
  return row?.createdAt ?? null;
}

/** Whether the tenant has an administrator who accepted the invitation — the precondition for handing it over. */
export async function countActiveTenantAdmins(ctx: PlatformContext, tenantId: string, client: Tx = db): Promise<number> {
  assertPlatformTenantRead(ctx);
  return mapErrors("Tenant", () =>
    // tenant-scope-exempt: platform membership metadata of the *target* tenant, authorised by the platform role.
    client.userTenant.count({ where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE" } }),
  );
}

// ─── Target tenant rows (lifecycle) ───

export type LockedTenant = { id: string; name: string; slug: string; status: TenantStatus; suspendedAt: Date | null; suspensionReason: string | null };

/** The target tenant, locked `FOR UPDATE` until the transaction ends (serialises concurrent lifecycle changes). */
export async function lockTenant(ctx: PlatformContext, tx: Tx, tenantId: string): Promise<LockedTenant | null> {
  assertPlatformTenantRead(ctx);
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; slug: string; status: TenantStatus; suspended_at: Date | null; suspension_reason: string | null }>>`
    SELECT id::text AS id, name, slug, status::text AS status, suspended_at, suspension_reason
    FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { id: row.id, name: row.name, slug: row.slug, status: row.status, suspendedAt: row.suspended_at, suspensionReason: row.suspension_reason } : null;
}

export async function findTenantStatus(ctx: PlatformContext, tenantId: string): Promise<{ id: string; status: TenantStatus } | null> {
  assertPlatformTenantRead(ctx);
  return mapErrors("Tenant", () => db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true } }));
}

/** SA-ADM-02: new name and/or slug. A slug collision is a 422 SLUG_TAKEN. */
export async function updateTenantIdentity(ctx: PlatformContext, tx: Tx, tenantId: string, data: { name?: string; slug?: string }): Promise<void> {
  assertPlatform(ctx, "platform:tenant:update");
  if (data.slug !== undefined && (await isSlugTaken(ctx, data.slug, tenantId, tx))) throw new SlugTakenError();
  try {
    await tx.tenant.update({ where: { id: tenantId }, data, select: { id: true } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SlugTakenError();
    throw error;
  }
}

export async function markTenantSuspended(ctx: PlatformContext, tx: Tx, tenantId: string, reason: string, at: Date): Promise<void> {
  assertPlatform(ctx, "platform:tenant:suspend");
  await tx.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: at, suspensionReason: reason }, select: { id: true } });
}

export async function markTenantActive(ctx: PlatformContext, tx: Tx, tenantId: string): Promise<void> {
  assertPlatform(ctx, "platform:tenant:reactivate");
  await tx.tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null }, select: { id: true } });
}

// ─── Invitees and memberships (SA-ADM-01, SA-ADM-05, SA-ADM-06) ───

export type Invitee = { id: string; email: string; fullName: string | null; status: UserStatus; platformRole: PlatformRole; clerkUserId: string | null };

export type TargetMembership = { id: string; tenantId: string; userId: string; role: TenantRole; status: MembershipStatus; clerkInvitationId: string | null };

const membershipSelect = { id: true, tenantId: true, userId: true, role: true, status: true, clerkInvitationId: true } as const;

/** The global USER with this (normalised) email, if any. USER is global identity, not tenant data. */
export async function findInvitee(ctx: PlatformContext, email: string, client: Tx = db): Promise<Invitee | null> {
  assertPlatform(ctx, "platform:tenant:read");
  return mapErrors("User", () =>
    client.user.findUnique({ where: { email }, select: { id: true, email: true, fullName: true, status: true, platformRole: true, clerkUserId: true } }),
  );
}

/** Creates the local USER for a new invitee (no Clerk link until first sign-in, ADR-006 §2). */
export async function createInvitee(ctx: PlatformContext, tx: Tx, email: string, fullName: string | null): Promise<Invitee> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  return tx.user.create({
    data: { email, fullName, platformRole: "NONE", status: "ACTIVE" },
    select: { id: true, email: true, fullName: true, status: true, platformRole: true, clerkUserId: true },
  });
}

/** The membership of `userId` in the target tenant, if any. */
export async function findMembershipOfUser(ctx: PlatformContext, tenantId: string, userId: string, client: Tx = db): Promise<TargetMembership | null> {
  assertPlatformTenantRead(ctx);
  return mapErrors("Membership", () => client.userTenant.findFirst({ where: { tenantId, userId }, select: membershipSelect }));
}

/** A membership of the target tenant by id; another tenant's membership id is a miss (null). */
export async function findTenantMembership(ctx: PlatformContext, tenantId: string, membershipId: string, client: Tx = db): Promise<TargetMembership | null> {
  assertPlatformTenantRead(ctx);
  return mapErrors("Membership", () => client.userTenant.findUnique({ where: { tenantId_id: { tenantId, id: membershipId } }, select: membershipSelect }));
}

export async function insertInvitedAdmin(
  ctx: PlatformContext,
  tx: Tx,
  row: { tenantId: string; userId: string; invitedAt: Date; clerkInvitationId: string | null },
): Promise<TargetMembership> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  return tx.userTenant.create({
    data: { tenantId: row.tenantId, userId: row.userId, role: "TENANT_ADMIN", status: "INVITED", invitedByUserId: ctx.userId, invitedAt: row.invitedAt, clerkInvitationId: row.clerkInvitationId },
    select: membershipSelect,
  });
}

/**
 * Re-invites on an existing membership row (UNIQUE (tenant_id, user_id)): a pending TENANT_ADMIN invitation is resent,
 * a deactivated membership becomes a fresh INVITED TENANT_ADMIN invitation.
 */
export async function reinviteAdmin(
  ctx: PlatformContext,
  tx: Tx,
  row: { tenantId: string; membershipId: string; invitedAt: Date; clerkInvitationId: string },
): Promise<TargetMembership> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  return tx.userTenant.update({
    where: { tenantId_id: { tenantId: row.tenantId, id: row.membershipId } },
    data: {
      role: "TENANT_ADMIN",
      status: "INVITED",
      invitedByUserId: ctx.userId,
      invitedAt: row.invitedAt,
      acceptedAt: null,
      deactivatedAt: null,
      deactivatedByUserId: null,
      clerkInvitationId: row.clerkInvitationId,
    },
    select: membershipSelect,
  });
}

/** Records the Clerk invitation of a still-pending membership. False when it is no longer INVITED. */
export async function recordAdminInvitation(ctx: PlatformContext, tenantId: string, membershipId: string, clerkInvitationId: string): Promise<boolean> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  const { count } = await mapErrors("Membership", () =>
    db.userTenant.updateMany({ where: { tenantId, id: membershipId, status: "INVITED" }, data: { clerkInvitationId } }),
  );
  return count === 1;
}

/** SA-ADM-06: a pending invitation becomes INACTIVE. Returns false when it was no longer INVITED. */
export async function deactivateInvitedMembership(ctx: PlatformContext, tx: Tx, tenantId: string, membershipId: string, at: Date): Promise<boolean> {
  assertPlatform(ctx, "platform:tenant_admin:invite");
  const { count } = await tx.userTenant.updateMany({
    where: { tenantId, id: membershipId, status: "INVITED" },
    data: { status: "INACTIVE", deactivatedAt: at, deactivatedByUserId: ctx.userId },
  });
  return count === 1;
}

// ─── Session revocation after suspension (SC-AUTH-08) ───

/**
 * Signed-in-before members of a just-suspended tenant who now have no usable restaurant at all: ACTIVE in this tenant,
 * linked to Clerk, not a platform administrator, and with no other ACTIVE membership in an ACTIVE tenant. Members who
 * still have another restaurant keep their session so they can switch (security.md §2.2 "Suspended tenant").
 */
export async function membersLosingAllAccess(ctx: PlatformContext, tenantId: string): Promise<Array<{ userId: string; clerkUserId: string }>> {
  assertPlatform(ctx, "platform:tenant:suspend");
  const rows = await mapErrors("Membership", () =>
    db.userTenant.findMany({
      where: { tenantId, status: "ACTIVE", user: { clerkUserId: { not: null }, platformRole: "NONE" } },
      select: {
        user: {
          select: {
            id: true,
            clerkUserId: true,
            memberships: { where: { status: "ACTIVE", tenantId: { not: tenantId }, tenant: { status: "ACTIVE" } }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
  );
  return rows.filter((r) => r.user.memberships.length === 0 && r.user.clerkUserId).map((r) => ({ userId: r.user.id, clerkUserId: r.user.clerkUserId! }));
}

// ─── Feature switches (RASOIOS-ADR-023) ───

/** The features switched off for one restaurant. A feature with no row is on. */
export async function disabledFeaturesOf(ctx: PlatformContext, tenantId: string, client: Tx = db): Promise<string[]> {
  assertPlatform(ctx, "platform:tenant:read");
  const rows = await client.tenantFeature.findMany({ where: { tenantId, enabled: false }, select: { featureKey: true } });
  return rows.map((r) => r.featureKey);
}

/** Writes one switch per feature given, recording who changed it. */
export async function writeFeatureSwitches(ctx: PlatformContext, tx: Tx, tenantId: string, switches: Record<string, boolean>): Promise<void> {
  for (const [featureKey, enabled] of Object.entries(switches)) {
    // tenant-scope-exempt: the compound key tenantId_featureKey names the tenant; platform-only writer (ADR-023)
    await tx.tenantFeature.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey } },
      create: { tenantId, featureKey, enabled, updatedByUserId: ctx.userId },
      update: { enabled, updatedByUserId: ctx.userId },
    });
  }
}
