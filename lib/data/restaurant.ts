import "server-only";
import type { OrderType, Prisma } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import type { AuditAction } from "@/lib/audit/actions";
import { audit } from "@/lib/audit/write";
import { db } from "@/lib/db/prisma";
import { ConflictError } from "@/lib/errors";
import { isValidTimeZone } from "@/lib/time/zone";
import type {
  OpeningDay,
  UpdateBrandingData,
  UpdateOperationalSettingsData,
  UpdateRestaurantProfileData,
  UpdateWebsiteSettingsData,
} from "@/lib/validation/settings";
import { instantDto } from "./dto";
import { mapErrors } from "./errors";
import { required, tenantScope } from "./scope";
import { withTx, type Tx } from "./tx";

/**
 * Restaurant settings data (S1-P07-T001; data-model.md E02–E03; api.md LD-RST-01, SA-RST-01…06).
 *
 * One restaurant per tenant (Q-002), always addressed by `tenant_id = ctx.tenantId` — the tenant never comes from
 * input. Every change and its audit row (security.md §7, before/after of the changed columns) commit in one
 * transaction (SC-AUD-01/02). A save that changes nothing writes nothing.
 */

// ─── Projection ───

const SETTINGS_SELECT = {
  id: true,
  name: true,
  description: true,
  logoUrl: true,
  coverImageUrl: true,
  brandAccentHex: true,
  phoneE164: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  timezone: true,
  currencyCode: true,
  showPhone: true,
  showEmail: true,
  showAddress: true,
  websitePublished: true,
  seoTitle: true,
  seoDescription: true,
  defaultOrderType: true,
  autoPrintKot: true,
  simplifiedWorkflow: true,
  receiptFooter: true,
  gstin: true,
  updatedAt: true,
} satisfies Prisma.RestaurantSelect;

type SettingsRow = Prisma.RestaurantGetPayload<{ select: typeof SETTINGS_SELECT }>;
type Column = Exclude<keyof SettingsRow, "id" | "updatedAt">;

/** Every E02 field of the caller's restaurant (explicit projection, SC-API-05). */
export type RestaurantSettingsDto = Omit<SettingsRow, "updatedAt" | "defaultOrderType"> & { defaultOrderType: OrderType; updatedAt: string };

function toSettingsDto(row: SettingsRow): RestaurantSettingsDto {
  return { ...row, updatedAt: instantDto(row.updatedAt) };
}

async function loadSettingsRow(client: Tx, ctx: TenantContext): Promise<SettingsRow> {
  return required(await client.restaurant.findUnique({ where: { tenantId: ctx.tenantId }, select: SETTINGS_SELECT }), "Restaurant");
}

// ─── Reads (LD-RST-01) ───

export type OpeningDayDto = OpeningDay;

const HOURS_SELECT = { dayOfWeek: true, sequence: true, isClosed: true, opensAt: true, closesAt: true } satisfies Prisma.RestaurantHoursSelect;
type HoursRow = Prisma.RestaurantHoursGetPayload<{ select: typeof HOURS_SELECT }>;

/** TIME(0) columns come back as 1970-01-01 UTC instants. */
const hhmm = (value: Date | null) => (value ? value.toISOString().slice(11, 16) : "");
const timeValue = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

/** Seven days, Monday first; a day without rows is closed (same shape SA-RST-03 accepts, so the editor round-trips). */
function toWeek(rows: HoursRow[]): OpeningDayDto[] {
  return Array.from({ length: 7 }, (_, index) => {
    const dayOfWeek = index + 1;
    const open = rows
      .filter((r) => r.dayOfWeek === dayOfWeek && !r.isClosed)
      .sort((a, b) => a.sequence - b.sequence)
      .map((r) => ({ opensAt: hhmm(r.opensAt), closesAt: hhmm(r.closesAt) }));
    return { dayOfWeek, isClosed: open.length === 0, shifts: open };
  });
}

/** Compact audit form: `{ "1": ["12:00-15:30", "19:00-23:30"], "7": "closed" }`. */
function weekSummary(week: OpeningDayDto[]): Record<string, unknown> {
  return Object.fromEntries(week.map((d) => [String(d.dayOfWeek), d.isClosed ? "closed" : d.shifts.map((s) => `${s.opensAt}-${s.closesAt}`)]));
}

async function loadWeek(client: Tx, ctx: TenantContext, restaurantId: string): Promise<OpeningDayDto[]> {
  const rows = await client.restaurantHours.findMany({
    where: tenantScope(ctx, { restaurantId }),
    orderBy: [{ dayOfWeek: "asc" }, { sequence: "asc" }],
    select: HOURS_SELECT,
  });
  return toWeek(rows);
}

export type WebsiteReadinessItem = { code: "RESTAURANT_NAME" | "TIMEZONE" | "PUBLISHED_MENU"; message: string };

/** SA-RST-06 prerequisites: a name, a valid time zone, and ≥1 published category with ≥1 published item. */
async function websiteReadiness(client: Tx, ctx: TenantContext, restaurant: { name: string; timezone: string }): Promise<WebsiteReadinessItem[]> {
  const missing: WebsiteReadinessItem[] = [];
  if (restaurant.name.trim().length < 2) missing.push({ code: "RESTAURANT_NAME", message: "Add the restaurant name." });
  if (!isValidTimeZone(restaurant.timezone)) missing.push({ code: "TIMEZONE", message: "Set the restaurant's time zone." });
  const menu = await client.menuCategory.findFirst({
    where: tenantScope(ctx, { isPublished: true, archivedAt: null, items: { some: { isPublished: true, archivedAt: null } } }),
    select: { id: true },
  });
  if (!menu) missing.push({ code: "PUBLISHED_MENU", message: "Publish at least one menu category that has at least one published item." });
  return missing;
}

/** INV-09: the currency is fixed once the tenant has any order. */
async function hasOrders(client: Tx, ctx: TenantContext): Promise<boolean> {
  return (await client.order.findFirst({ where: tenantScope(ctx), select: { id: true } })) !== null;
}

export type RestaurantSettingsSnapshot = {
  restaurant: RestaurantSettingsDto;
  hours: OpeningDayDto[];
  slug: string;
  subdomain?: string | null;
  currencyLocked: boolean;
  websiteReadiness: WebsiteReadinessItem[];
};

/** LD-RST-01 data for the caller's restaurant. */
export async function getRestaurantSettingsSnapshot(ctx: TenantContext): Promise<RestaurantSettingsSnapshot> {
  return mapErrors("Restaurant", async () => {
    const row = await loadSettingsRow(db, ctx);
    const [hours, tenant, currencyLocked, readiness] = await Promise.all([
      loadWeek(db, ctx, row.id),
      db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true, subdomain: true } }),
      hasOrders(db, ctx),
      websiteReadiness(db, ctx, row),
    ]);
    const t = required(tenant, "Restaurant");
    return { restaurant: toSettingsDto(row), hours, slug: t.slug, subdomain: t.subdomain, currencyLocked, websiteReadiness: readiness };
  });
}

/** Whether the caller's restaurant runs the simplified order workflow (owner brief 2026-10-13). */
export async function isSimplifiedWorkflowOn(ctx: TenantContext): Promise<boolean> {
  const row = await mapErrors("Restaurant", () => db.restaurant.findUnique({ where: { tenantId: ctx.tenantId }, select: { simplifiedWorkflow: true } }));
  return row?.simplifiedWorkflow ?? false;
}

/** The public website slug of the caller's tenant (for `revalidatePath('/r/{slug}')`). */
export async function tenantSlug(ctx: TenantContext): Promise<string> {
  const tenant = await mapErrors("Restaurant", () => db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true } }));
  return required(tenant, "Restaurant").slug;
}

// ─── Writes ───

type Patch = Partial<Record<Column, string | boolean | null>>;

const pick = (row: SettingsRow, columns: Column[]) => Object.fromEntries(columns.map((c) => [c, row[c]]));

/**
 * Applies the columns of `patch` that differ from the stored row and audits them as `action` (before/after of the
 * changed columns only). `beforeWrite` runs inside the transaction with the current row (business rules).
 */
async function patchRestaurant(
  ctx: TenantContext,
  patch: Patch,
  action: AuditAction,
  beforeWrite?: (tx: Tx, before: SettingsRow, changed: Column[]) => Promise<void>,
): Promise<RestaurantSettingsDto> {
  return withTx(ctx, async (tx) => {
    const before = await loadSettingsRow(tx, ctx);
    const changed = (Object.keys(patch) as Column[]).filter((c) => patch[c] !== undefined && patch[c] !== before[c]);
    if (changed.length === 0) return toSettingsDto(before);
    await beforeWrite?.(tx, before, changed);

    const data = Object.fromEntries(changed.map((c) => [c, patch[c]])) as Prisma.RestaurantUpdateInput;
    const after = await tx.restaurant.update({ where: { tenantId: ctx.tenantId }, data, select: SETTINGS_SELECT });
    await audit(tx, ctx, { action, resourceType: "restaurant", resourceId: after.id, before: pick(before, changed), after: pick(after, changed) });
    return toSettingsDto(after);
  });
}

/** SA-RST-01 — name, description, contact and address (`restaurant.profile_updated`). */
export function updateRestaurantProfile(ctx: TenantContext, input: UpdateRestaurantProfileData): Promise<RestaurantSettingsDto> {
  return patchRestaurant(ctx, { ...input }, "restaurant.profile_updated");
}

/** SA-RST-02 — logo, cover image, accent colour (`restaurant.branding_updated`). */
export function updateRestaurantBranding(ctx: TenantContext, input: UpdateBrandingData): Promise<RestaurantSettingsDto> {
  return patchRestaurant(ctx, { ...input }, "restaurant.branding_updated");
}

/**
 * SA-RST-04 — time zone, currency, country, order defaults, receipt footer, GSTIN (`restaurant.settings_updated`).
 * A currency change after the first order fails with 409 CURRENCY_LOCKED (INV-09); nothing is written.
 */
export function updateOperationalSettings(ctx: TenantContext, input: UpdateOperationalSettingsData): Promise<RestaurantSettingsDto> {
  return patchRestaurant(ctx, { ...input }, "restaurant.settings_updated", async (tx, _before, changed) => {
    if (changed.includes("currencyCode") && (await hasOrders(tx, ctx))) {
      throw new ConflictError("The currency can't be changed after the first order has been taken.", "CURRENCY_LOCKED");
    }
  });
}

/** SA-RST-05 — contact visibility and SEO (`restaurant.website_updated`). */
export function updateWebsiteSettings(ctx: TenantContext, input: UpdateWebsiteSettingsData): Promise<RestaurantSettingsDto> {
  return patchRestaurant(ctx, { ...input }, "restaurant.website_updated");
}

export type PublishOutcome = { outcome: "UPDATED" | "UNCHANGED"; restaurant: RestaurantSettingsDto } | { outcome: "NOT_READY"; missing: WebsiteReadinessItem[] };

/**
 * SA-RST-06 — publish or unpublish the public website (`restaurant.website_published` / `_unpublished`). Publishing
 * re-checks readiness inside the same transaction; unpublishing is always allowed. Setting the current state is a
 * no-op without an audit row.
 */
export async function setWebsitePublished(ctx: TenantContext, published: boolean): Promise<PublishOutcome> {
  return withTx(ctx, async (tx): Promise<PublishOutcome> => {
    const before = await loadSettingsRow(tx, ctx);
    if (before.websitePublished === published) return { outcome: "UNCHANGED", restaurant: toSettingsDto(before) };
    if (published) {
      const missing = await websiteReadiness(tx, ctx, before);
      if (missing.length > 0) return { outcome: "NOT_READY", missing };
    }
    const after = await tx.restaurant.update({ where: { tenantId: ctx.tenantId }, data: { websitePublished: published }, select: SETTINGS_SELECT });
    await audit(tx, ctx, {
      action: published ? "restaurant.website_published" : "restaurant.website_unpublished",
      resourceType: "restaurant",
      resourceId: after.id,
      before: { websitePublished: before.websitePublished },
      after: { websitePublished: after.websitePublished },
    });
    return { outcome: "UPDATED", restaurant: toSettingsDto(after) };
  });
}

/**
 * SA-RST-03 — replaces the whole weekly set in one transaction (`restaurant.hours_updated` with the full week
 * before/after). The restaurant row is locked first so concurrent saves apply one after the other.
 */
export async function replaceOpeningHours(ctx: TenantContext, days: readonly OpeningDay[]): Promise<OpeningDayDto[]> {
  return withTx(ctx, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM restaurants WHERE tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    const restaurantId = required(locked[0], "Restaurant").id;
    const before = await loadWeek(tx, ctx, restaurantId);

    const rows: Prisma.RestaurantHoursCreateManyInput[] = [...days]
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
      .flatMap((day): Prisma.RestaurantHoursCreateManyInput[] =>
        day.isClosed
          ? [{ tenantId: ctx.tenantId, restaurantId, dayOfWeek: day.dayOfWeek, sequence: 1, isClosed: true, opensAt: null, closesAt: null }]
          : [...day.shifts]
              .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
              .map((shift, i) => ({
                tenantId: ctx.tenantId,
                restaurantId,
                dayOfWeek: day.dayOfWeek,
                sequence: i + 1,
                isClosed: false,
                opensAt: timeValue(shift.opensAt),
                closesAt: timeValue(shift.closesAt),
              })),
      );
    await tx.restaurantHours.deleteMany({ where: tenantScope(ctx, { restaurantId }) });
    await tx.restaurantHours.createMany({ data: rows });

    const after = await loadWeek(tx, ctx, restaurantId);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) {
      await audit(tx, ctx, {
        action: "restaurant.hours_updated",
        resourceType: "restaurant",
        resourceId: restaurantId,
        before: { days: weekSummary(before) },
        after: { days: weekSummary(after) },
      });
    }
    return after;
  });
}
