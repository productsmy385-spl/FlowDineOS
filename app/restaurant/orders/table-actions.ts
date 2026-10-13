"use server";

import { requirePermission, requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import {
  closeTableBill,
  getTableBill,
  getTableBillReceipts,
  listOpenTableBills,
  lookupTableBill,
  payTableBill,
  retryTableBillReceipts,
} from "@/lib/services/table-sessions";
import { parseInput } from "@/lib/validation/core";
import {
  closeTableBillSchema,
  lookupTableBillSchema,
  payTableBillSchema,
  tableBillIdSchema,
  tableBillPaymentSchema,
  type CloseTableBillInput,
  type LookupTableBillInput,
  type PayTableBillInput,
  type TableBillIdInput,
  type TableBillPaymentInput,
} from "@/lib/validation/table-sessions";

/**
 * Table bills (RASOIOS-ADR-027). The tenant and actor come only from the server-resolved context; every input is
 * strict, and no total is ever taken from the client — only the amount being paid and the bill version it was based on.
 */

/** One bill with its orders, lines, totals and payments — `order:read` + `transaction:read` (amounts). */
export const getTableBillAction = action(async (input: TableBillIdInput) => {
  const ctx = await requireTenant("order:read");
  requirePermission(ctx, "transaction:read");
  const { tableSessionId } = parseInput(tableBillIdSchema, input);
  return getTableBill(ctx, tableSessionId);
});

/** Every open bill, for the Orders board — `order:read` + `transaction:read`. */
export const listOpenTableBillsAction = action(async () => {
  const ctx = await requireTenant("order:read");
  requirePermission(ctx, "transaction:read");
  return listOpenTableBills(ctx);
});

/** Order entry: which open bill a dine-in order for this table would join — `order:create`. */
export const lookupTableBillAction = action(async (input: LookupTableBillInput) => {
  const ctx = await requireTenant("order:create");
  const { tableLabel } = parseInput(lookupTableBillSchema, input);
  return lookupTableBill(ctx, tableLabel);
});

/** Record Payment for the whole table — `payment:record` + `transaction:read`. */
export const payTableBillAction = action(async (input: PayTableBillInput) => {
  const ctx = await requireTenant("payment:record");
  requirePermission(ctx, "transaction:read");
  return payTableBill(ctx, parseInput(payTableBillSchema, input));
});

/** Close a bill that owes nothing — `payment:record`. */
export const closeTableBillAction = action(async (input: CloseTableBillInput) => {
  const ctx = await requireTenant("payment:record");
  const { tableSessionId, expectedVersion } = parseInput(closeTableBillSchema, input);
  return closeTableBill(ctx, tableSessionId, expectedVersion);
});

/** Live queue status of a table payment's receipt copies — `print_job:read`. */
export const getTableBillReceiptsAction = action(async (input: TableBillPaymentInput) => {
  const ctx = await requireTenant("print_job:read");
  const { paymentId } = parseInput(tableBillPaymentSchema, input);
  return getTableBillReceipts(ctx, paymentId);
});

/** Requeue failed receipt copies of a settled bill, or queue them if none were — `print_job:retry` + `transaction:read`. */
export const retryTableBillReceiptsAction = action(async (input: TableBillPaymentInput) => {
  const ctx = await requireTenant("print_job:retry");
  requirePermission(ctx, "transaction:read");
  const { paymentId } = parseInput(tableBillPaymentSchema, input);
  return retryTableBillReceipts(ctx, paymentId);
});
