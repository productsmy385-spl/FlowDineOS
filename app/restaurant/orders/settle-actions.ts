"use server";

import { requirePermission, requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { getPaymentReceipts, getSettlement, retryPaymentReceipts, settleOrder } from "@/lib/services/simplified-workflow";
import { parseInput } from "@/lib/validation/core";
import {
  paymentReceiptsSchema,
  settlementQuerySchema,
  settleOrderSchema,
  type PaymentReceiptsInput,
  type SettleOrderInput,
  type SettlementQueryInput,
} from "@/lib/validation/simplified-workflow";

/**
 * Simplified order workflow — Record Payment on the Orders board (owner brief 2026-10-13). The tenant and actor come
 * only from the server-resolved context; inputs are strict. Each action refuses with 409 WORKFLOW_DISABLED when the
 * restaurant has the workflow off, so the manual flow cannot be bypassed from here.
 */

/** What the dialog shows before taking money — `payment:record` + `transaction:read` (amounts and balance). */
export const getSettlementAction = action(async (input: SettlementQueryInput) => {
  const ctx = await requireTenant("payment:record");
  requirePermission(ctx, "transaction:read");
  const { orderId } = parseInput(settlementQuerySchema, input);
  return getSettlement(ctx, orderId);
});

/** Customer (if missing) → payment → completion where allowed → receipt status — `payment:record`. */
export const settleOrderAction = action(async (input: SettleOrderInput) => {
  const ctx = await requireTenant("payment:record");
  const data = parseInput(settleOrderSchema, input);
  return settleOrder(ctx, data);
});

/** Live queue status of one payment's receipt copies — `print_job:read`. */
export const getPaymentReceiptsAction = action(async (input: PaymentReceiptsInput) => {
  const ctx = await requireTenant("print_job:read");
  const { orderId, transactionId } = parseInput(paymentReceiptsSchema, input);
  return getPaymentReceipts(ctx, orderId, transactionId);
});

/** Requeue a payment's FAILED receipt copies, or queue them if none were — `print_job:retry` + `transaction:read`. */
export const retryPaymentReceiptsAction = action(async (input: PaymentReceiptsInput) => {
  const ctx = await requireTenant("print_job:retry");
  requirePermission(ctx, "transaction:read");
  const { orderId, transactionId } = parseInput(paymentReceiptsSchema, input);
  return retryPaymentReceipts(ctx, orderId, transactionId);
});
