import "server-only";
import type { TenantContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { tenantKey, tenantScope } from "./scope";

/** Look-ups for importing customers and menu items from a spreadsheet (RASOIOS-ADR-022). All tenant-scoped. */

/** Phones already used by a live customer of this restaurant. */
export async function existingCustomerPhones(ctx: TenantContext, phones: string[]): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const rows = await db.customer.findMany({ where: tenantScope(ctx, { phoneE164: { in: phones }, archivedAt: null, anonymizedAt: null }), select: { phoneE164: true } });
  return new Set(rows.flatMap((r) => (r.phoneE164 ? [r.phoneE164] : [])));
}

/** Live categories by lower-cased name. */
export async function categoriesByName(ctx: TenantContext): Promise<Map<string, string>> {
  const rows = await db.menuCategory.findMany({ where: tenantScope(ctx, { archivedAt: null }), select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
}

/** `categoryId|lower(name)` of every live menu item, to spot a dish that is already on the menu. */
export async function existingItemKeys(ctx: TenantContext): Promise<Set<string>> {
  const rows = await db.menuItem.findMany({ where: tenantScope(ctx, { archivedAt: null }), select: { categoryId: true, name: true } });
  return new Set(rows.map((r) => `${r.categoryId}|${r.name.trim().toLowerCase()}`));
}

/** The restaurant's country, for turning local phone numbers into international ones. */
export async function restaurantCountry(ctx: TenantContext): Promise<string> {
  const row = await db.restaurant.findUniqueOrThrow({ where: tenantKey(ctx, ctx.restaurant.id), select: { countryCode: true } });
  return row.countryCode;
}
