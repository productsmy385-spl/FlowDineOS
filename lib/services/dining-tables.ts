import "server-only";
import { randomBytes } from "node:crypto";
import { audit } from "@/lib/audit/write";
import type { TenantContext } from "@/lib/auth/context-types";
import { findTable, insertTable, labelTaken, listTables, nextSortOrder, publicState, updateTable, type DiningTableRow } from "@/lib/data/dining-tables";
import { required } from "@/lib/data/scope";
import { withTx } from "@/lib/data/tx";
import { appUrl } from "@/lib/env";
import { ConflictError, ValidationError } from "@/lib/errors";
import { qrPath, qrSvg } from "@/lib/qr";
import { canonicalPublicUrl } from "@/lib/tenancy/request";

/**
 * Table QR menus (RASOIOS-ADR-021; owner brief 2026-10-06 §11). A table's QR opens the restaurant's own public menu at
 * `/t/{code}`: the code is random, carries no tenant or row id, and rotating it retires every printed copy at once.
 */

const MAX_TABLES = 200;
/** No 0/o/1/l, in case a code is ever read aloud. 32 symbols, so `byte % 32` has no bias. */
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newTableCode(): string {
  return Array.from(randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** The address a table's QR encodes: the restaurant's canonical host when configured, else the `/r/{slug}` path. */
export function tableMenuUrl(slug: string, code: string): string {
  const canonical = canonicalPublicUrl(slug);
  const base = canonical ? canonical.replace(/\/$/, "") : `${(appUrl() ?? "http://localhost:3000").replace(/\/$/, "")}/r/${slug}`;
  return `${base}/t/${code}`;
}

export type TableView = { id: string; label: string; isActive: boolean; url: string; qr: { size: number; d: string }; qrSvg: string };
export type TablesOverview = { restaurantName: string; websitePublished: boolean; tables: TableView[] };

function toView(slug: string, name: string) {
  return (row: DiningTableRow): TableView => {
    const url = tableMenuUrl(slug, row.publicCode);
    return { id: row.id, label: row.label, isActive: row.isActive, url, qr: qrPath(url), qrSvg: qrSvg(url, `${name} - ${row.label} menu`) };
  };
}

export async function getTables(ctx: TenantContext): Promise<TablesOverview> {
  return withTx(ctx, async (tx) => {
    const state = await publicState(tx, ctx);
    const rows = await listTables(tx, ctx);
    return { restaurantName: state.name, websitePublished: state.websitePublished, tables: rows.map(toView(state.slug, state.name)) };
  });
}

/** Adds one named table, or `count` tables numbered after the ones already there (Table 01, Table 02, ...). */
export async function addTables(ctx: TenantContext, input: { label?: string; count?: number }): Promise<{ created: number }> {
  return withTx(ctx, async (tx) => {
    const existing = await listTables(tx, ctx);
    const labels: string[] = [];
    if (input.label) {
      if (await labelTaken(tx, ctx, input.label)) throw new ConflictError(`There is already a table called ${input.label}.`, "TABLE_LABEL_TAKEN");
      labels.push(input.label);
    } else {
      const used = new Set(existing.map((t) => t.label.toLowerCase()));
      for (let n = 1; labels.length < (input.count ?? 1) && n < 1000; n++) {
        const label = `Table ${String(n).padStart(2, "0")}`;
        if (!used.has(label.toLowerCase())) labels.push(label);
      }
    }
    if (existing.length + labels.length > MAX_TABLES) throw new ValidationError(`A restaurant can have up to ${MAX_TABLES} tables.`, { count: [`Up to ${MAX_TABLES} tables.`] });
    let sortOrder = await nextSortOrder(tx, ctx);
    for (const label of labels) {
      const row = await insertTable(tx, ctx, { label, publicCode: newTableCode(), sortOrder: sortOrder++ });
      await audit(tx, ctx, { action: "dining_table.created", resourceType: "dining_table", resourceId: row.id, after: { label } });
    }
    return { created: labels.length };
  });
}

export async function editTable(ctx: TenantContext, input: { id: string; label?: string; isActive?: boolean }): Promise<{ id: string }> {
  return withTx(ctx, async (tx) => {
    const before = required(await findTable(tx, ctx, input.id), "Table");
    if (input.label !== undefined && (await labelTaken(tx, ctx, input.label, input.id))) throw new ConflictError(`There is already a table called ${input.label}.`, "TABLE_LABEL_TAKEN");
    const after = await updateTable(tx, ctx, input.id, { label: input.label, isActive: input.isActive });
    await audit(tx, ctx, {
      action: "dining_table.updated",
      resourceType: "dining_table",
      resourceId: input.id,
      before: { label: before.label, isActive: before.isActive },
      after: { label: after.label, isActive: after.isActive },
    });
    return { id: input.id };
  });
}

/** A new code for the table: every QR printed with the old one stops working immediately. */
export async function rotateTableCode(ctx: TenantContext, id: string): Promise<{ id: string }> {
  return withTx(ctx, async (tx) => {
    const table = required(await findTable(tx, ctx, id), "Table");
    await updateTable(tx, ctx, id, { publicCode: newTableCode() });
    await audit(tx, ctx, { action: "dining_table.code_rotated", resourceType: "dining_table", resourceId: id, after: { label: table.label } });
    return { id };
  });
}

/** Archived, not deleted: the label becomes free again and the QR stops working. */
export async function archiveTable(ctx: TenantContext, id: string): Promise<{ id: string }> {
  return withTx(ctx, async (tx) => {
    const table = required(await findTable(tx, ctx, id), "Table");
    await updateTable(tx, ctx, id, { archivedAt: new Date(), isActive: false });
    await audit(tx, ctx, { action: "dining_table.archived", resourceType: "dining_table", resourceId: id, before: { label: table.label } });
    return { id };
  });
}
