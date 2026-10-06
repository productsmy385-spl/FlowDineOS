"use server";

import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { addTables, archiveTable, editTable, getTables, rotateTableCode } from "@/lib/services/dining-tables";
import { parseInput } from "@/lib/validation/core";
import { addTablesSchema, editTableSchema, tableIdSchema, type AddTablesInput, type EditTableInput, type TableIdInput } from "@/lib/validation/tables";

/** Tables and QR codes (RASOIOS-ADR-021) — `table:manage` (owner/administrator and manager). */

/** LD-TBL-01 — the restaurant's tables with each QR's address and image. */
export const listTablesAction = action(async () => {
  const ctx = await requireTenant("table:manage");
  return getTables(ctx);
});

/** SA-TBL-01 — one named table, or a numbered batch. */
export const addTablesAction = action(async (input: AddTablesInput) => {
  const ctx = await requireTenant("table:manage");
  return addTables(ctx, parseInput(addTablesSchema, input));
});

/** SA-TBL-02 — rename, or switch the QR on/off. */
export const editTableAction = action(async (input: EditTableInput) => {
  const ctx = await requireTenant("table:manage");
  return editTable(ctx, parseInput(editTableSchema, input));
});

/** SA-TBL-03 — new code; printed copies of the old QR stop working. */
export const rotateTableCodeAction = action(async (input: TableIdInput) => {
  const ctx = await requireTenant("table:manage");
  return rotateTableCode(ctx, parseInput(tableIdSchema, input).id);
});

/** SA-TBL-04 — archive the table. */
export const archiveTableAction = action(async (input: TableIdInput) => {
  const ctx = await requireTenant("table:manage");
  return archiveTable(ctx, parseInput(tableIdSchema, input).id);
});
