import "server-only";
import type { TenantContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { SLUG_PATTERN } from "@/lib/validation/core";
import { tenantKey, tenantScope } from "./scope";
import type { Tx } from "./tx";

/**
 * Dining tables and their QR codes (RASOIOS-ADR-021). Everything for the console is scoped to `ctx.tenantId`; the one
 * public read resolves a table only through the restaurant's own public slug *and* the table's random code.
 */

const select = { id: true, label: true, publicCode: true, isActive: true, sortOrder: true, createdAt: true, updatedAt: true } as const;
export type DiningTableRow = { id: string; label: string; publicCode: string; isActive: boolean; sortOrder: number; createdAt: Date; updatedAt: Date };

export async function listTables(tx: Tx, ctx: TenantContext): Promise<DiningTableRow[]> {
  return tx.diningTable.findMany({ where: tenantScope(ctx, { archivedAt: null }), orderBy: [{ sortOrder: "asc" }, { label: "asc" }], select });
}

export async function findTable(tx: Tx, ctx: TenantContext, id: string): Promise<DiningTableRow | null> {
  return tx.diningTable.findFirst({ where: tenantScope(ctx, { id, archivedAt: null }), select });
}

export async function nextSortOrder(tx: Tx, ctx: TenantContext): Promise<number> {
  const last = await tx.diningTable.aggregate({ where: tenantScope(ctx, { archivedAt: null }), _max: { sortOrder: true } });
  return (last._max.sortOrder ?? -1) + 1;
}

export async function insertTable(tx: Tx, ctx: TenantContext, data: { label: string; publicCode: string; sortOrder: number }): Promise<DiningTableRow> {
  return tx.diningTable.create({ data: { ...data, tenantId: ctx.tenantId }, select });
}

export async function updateTable(tx: Tx, ctx: TenantContext, id: string, data: { label?: string; isActive?: boolean; publicCode?: string; archivedAt?: Date }): Promise<DiningTableRow> {
  return tx.diningTable.update({ where: tenantKey(ctx, id), data, select });
}

/** Public: the label of an active table, by the restaurant's slug and the code printed on the QR. `null` otherwise. */
export async function findPublicTable(slug: string, code: string): Promise<{ label: string } | null> {
  if (!SLUG_PATTERN.test(slug) || !/^[a-z0-9]{8,16}$/.test(code)) return null;
  // The table menu needs the Table QR feature on; it no longer needs a published website (owner request 2026-10-07).
  const tenant = await db.tenant.findFirst({ where: { slug, status: "ACTIVE", features: { none: { featureKey: "QR_MENU", enabled: false } } }, select: { id: true } });
  if (!tenant) return null;
  return db.diningTable.findFirst({ where: { tenantId: tenant.id, publicCode: code, isActive: true, archivedAt: null }, select: { label: true } });
}

/** The restaurant's public slug and whether its website — where every table QR leads — is published. */
export async function publicState(tx: Tx, ctx: TenantContext): Promise<{ slug: string; name: string; websitePublished: boolean }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { slug: true } });
  const restaurant = await tx.restaurant.findUniqueOrThrow({ where: tenantKey(ctx, ctx.restaurant.id), select: { name: true, websitePublished: true } });
  return { slug: tenant.slug, ...restaurant };
}

/** Case-insensitive: is this label already used by another live table here? */
export async function labelTaken(tx: Tx, ctx: TenantContext, label: string, exceptId?: string): Promise<boolean> {
  const row = await tx.diningTable.findFirst({
    where: tenantScope(ctx, { archivedAt: null, label: { equals: label, mode: "insensitive" as const }, ...(exceptId ? { NOT: { id: exceptId } } : {}) }),
    select: { id: true },
  });
  return row !== null;
}
