import "server-only";
import { randomUUID } from "node:crypto";
import { OrderStatus, PaymentStatus, PrintJobStatus, TransactionType } from "@prisma/client";
import type { SystemContext, TenantContext } from "@/lib/auth/context-types";
import { hasPermission } from "@/lib/auth/permissions";
import { AUTO_READY_TRIGGER, autoReadyOrder, findOrdersDueForAutoReady } from "@/lib/data/auto-ready";
import { findCustomerByPhone } from "@/lib/data/customers";
import { findOrderDetail } from "@/lib/data/orders";
import { findLedgerRow } from "@/lib/data/payments";
import { listPaymentReceiptJobs, type PrintJobDto } from "@/lib/data/printing";
import { isSimplifiedWorkflowOn } from "@/lib/data/restaurant";
import { required } from "@/lib/data/scope";
import { withTx } from "@/lib/data/tx";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { PrintJobDisplayStatus } from "@/lib/print/state-machine";
import { createCustomer } from "@/lib/services/customers";
import { setOrderCustomer, updateOrderStatus } from "@/lib/services/orders";
import { recordPayment, type PaymentResult } from "@/lib/services/payments";
import { queueReceiptForPayment, retryPrintJob, type ReceiptQueueOutcome } from "@/lib/services/printing";
import type { SettleOrderData } from "@/lib/validation/simplified-workflow";

/**
 * Simplified order workflow (owner brief 2026-10-13). A per-restaurant switch (`restaurants.simplified_workflow`, off
 * by default) that changes two things and nothing else:
 *
 * 1. **Timer.** An accepted order becomes READY 10 minutes after `accepted_at`, run by `runAutoReadySweep` on the
 *    server — never in a browser — so it happens with every screen closed (lib/data/auto-ready.ts has the guarantees).
 * 2. **Settle from the board.** `settleOrder` takes the payment through the existing ledger service (idempotent per
 *    submit, same amount rules, same receipt queueing keyed to the payment), then completes the order where the order
 *    lifecycle already allows it (READY and PAID), and reports each receipt copy's real queue status.
 *
 * With the switch off, the sweep skips the restaurant and `settleOrder` refuses: the manual workflow is untouched.
 */

/** Minutes from acceptance to the automatic READY. */
export const AUTO_READY_AFTER_MINUTES = 10;

// ─── 1. Timer ───

export type SweepResult = { scanned: number; advanced: number };

/**
 * One pass of the timer: every eligible order whose acceptance is at least `AUTO_READY_AFTER_MINUTES` old becomes
 * READY. Safe to run from any number of processes at once. One order failing never stops the others.
 */
export async function runAutoReadySweep(at: Date = new Date(), limit = 200): Promise<SweepResult> {
  const ctx: SystemContext = { kind: "system", requestId: randomUUID(), job: AUTO_READY_TRIGGER };
  const cutoff = new Date(at.getTime() - AUTO_READY_AFTER_MINUTES * 60_000);
  const due = await findOrdersDueForAutoReady(cutoff, limit);

  let advanced = 0;
  for (const order of due) {
    try {
      const outcome = await autoReadyOrder(ctx, order, cutoff, at);
      if (!outcome.advanced) continue;
      advanced++;
      logger.info("order.status_changed", {
        requestId: ctx.requestId,
        tenantId: order.tenantId,
        orderId: order.orderId,
        orderNumber: outcome.orderNumber,
        from: outcome.from,
        to: OrderStatus.READY,
        trigger: AUTO_READY_TRIGGER,
      });
    } catch (error) {
      logger.error("order.auto_ready_failed", { requestId: ctx.requestId, tenantId: order.tenantId, orderId: order.orderId, error: String(error) });
    }
  }
  return { scanned: due.length, advanced };
}

// ─── 2. Settle from the board ───

async function assertSimplifiedWorkflow(ctx: TenantContext): Promise<void> {
  if (!(await isSimplifiedWorkflowOn(ctx))) {
    throw new ConflictError("The simplified order workflow is switched off for this restaurant. Use the order page to take payment.", "WORKFLOW_DISABLED");
  }
}

export type SettlementView = {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  currencyCode: string;
  totalAmount: string | null;
  balanceDue: string | null;
  /** The customer already on the order. When set, the dialog shows it and never sends a replacement. */
  customer: { name: string; phone: string | null } | null;
  /** The order will be completed straight after a settling payment (it is READY and the caller may complete). */
  completesOnPayment: boolean;
};

/** What the Record Payment dialog needs to open. Missing and other-tenant orders are both NOT_FOUND. */
export async function getSettlement(ctx: TenantContext, orderId: string): Promise<SettlementView> {
  await assertSimplifiedWorkflow(ctx);
  const order = required(await findOrderDetail(ctx, orderId), "Order");
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currencyCode: order.currencyCode,
    totalAmount: order.totalAmount,
    balanceDue: order.balanceDue,
    customer: order.customer ? { name: order.customer.fullName, phone: order.customer.phoneE164 } : null,
    completesOnPayment: order.status === OrderStatus.READY && hasPermission(ctx, "order:complete"),
  };
}

export type ReceiptCopyView = {
  printJobId: string;
  copyLabel: string | null;
  copyIndex: number | null;
  copyCount: number | null;
  /** The queue's own status: QUEUED, PRINTING (sending), RETRYING, DELIVERED, FAILED or CANCELLED — never "printed". */
  status: PrintJobDisplayStatus;
  error: string | null;
};

export function receiptCopyView(job: PrintJobDto): ReceiptCopyView {
  return {
    printJobId: job.id,
    copyLabel: job.copyLabel,
    copyIndex: job.copyIndex,
    copyCount: job.copyCount,
    status: job.displayStatus,
    error: job.lastErrorMessage,
  };
}

export type CompletionOutcome = "COMPLETED" | "ALREADY_COMPLETED" | "NOT_READY" | "NOT_PAID" | "NOT_PERMITTED" | "FAILED";

export type SettlementResult = {
  payment: PaymentResult;
  customer: "KEPT" | "LINKED" | "CREATED" | "NONE";
  completion: CompletionOutcome;
  completionMessage: string | null;
  /** What queueing the receipt reported on this call ("NOT_REQUESTED" on a replayed submit). */
  receiptQueue: ReceiptQueueOutcome["status"];
  /** Every receipt copy this payment has queued so far, with its live queue status. */
  receipts: ReceiptCopyView[];
};

/**
 * Attach the customer if the order has none — never replacing or editing one it already has (BR-CUST-02). A phone that
 * belongs to an existing customer links that customer as stored; otherwise a new customer is created and linked.
 */
async function attachCustomer(ctx: TenantContext, orderId: string, existing: boolean, input: SettleOrderData["customer"]): Promise<SettlementResult["customer"]> {
  if (existing) return "KEPT";
  if (!input) return "NONE";

  if (input.phone) {
    const match = await withTx(ctx, (tx) => findCustomerByPhone(tx, ctx, input.phone!));
    if (match) {
      if (!hasPermission(ctx, "customer:read")) throw new ForbiddenError("You can't attach an existing customer to an order.");
      await setOrderCustomer(ctx, { orderId, customerId: match.id });
      return "LINKED";
    }
  }
  if (!input.name) {
    throw new ValidationError("Check the highlighted fields.", { "customer.name": ["Enter the customer's name, or leave both fields empty"] });
  }
  if (!hasPermission(ctx, "customer:create")) throw new ForbiddenError("You can't add a new customer. Leave the customer fields empty or ask a manager.");
  const created = await createCustomer(ctx, { fullName: input.name, phoneE164: input.phone ?? null, email: null, notes: null });
  await setOrderCustomer(ctx, { orderId, customerId: created.id });
  return "CREATED";
}

async function completeIfAllowed(ctx: TenantContext, orderId: string, payment: PaymentResult): Promise<{ completion: CompletionOutcome; message: string | null }> {
  if (payment.paymentStatus !== PaymentStatus.PAID) return { completion: "NOT_PAID", message: `A balance of ${payment.balance} is still due.` };
  return completeOrderIfReady(ctx, orderId);
}

/**
 * Completes a paid order through the existing state machine when it is READY (READY → COMPLETED requires PAID,
 * BR-ORD-06) and the caller may complete orders. Anything else is reported, never forced: an order still in the
 * kitchen stays open, a cancelled one is untouched.
 */
export async function completeOrderIfReady(ctx: TenantContext, orderId: string): Promise<{ completion: CompletionOutcome; message: string | null }> {
  if (!hasPermission(ctx, "order:complete")) return { completion: "NOT_PERMITTED", message: "Paid in full. Your role can't complete orders." };

  const order = required(await findOrderDetail(ctx, orderId), "Order");
  if (order.paymentStatus !== PaymentStatus.PAID) return { completion: "NOT_PAID", message: `A balance of ${order.balanceDue} is still due.` };
  if (order.status === OrderStatus.COMPLETED) return { completion: "ALREADY_COMPLETED", message: null };
  if (order.status !== OrderStatus.READY) {
    return { completion: "NOT_READY", message: "Paid in full. Complete the order once it is ready." };
  }
  try {
    await updateOrderStatus(ctx, { orderId, status: OrderStatus.COMPLETED, reason: null, expectedVersion: order.version });
    return { completion: "COMPLETED", message: null };
  } catch (error) {
    // The payment has committed; a lost race on completion must not look like a failed payment.
    logger.warn("order.settle_complete_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, orderId, error: String(error) });
    return { completion: "FAILED", message: error instanceof AppError ? error.message : "Paid in full, but the order could not be completed. Complete it from the order page." };
  }
}

/**
 * Record Payment from the Orders board: customer (if missing) → payment (the ledger service; its idempotency key makes a
 * double click or a retry after a lost response replay the same payment and the same receipt jobs) → completion where
 * the lifecycle allows → receipt status. Each step after the payment is reported, never rolled back into it.
 */
export async function settleOrder(ctx: TenantContext, data: SettleOrderData): Promise<SettlementResult> {
  await assertSimplifiedWorkflow(ctx);
  const order = required(await findOrderDetail(ctx, data.orderId), "Order");
  const customer = await attachCustomer(ctx, order.id, order.customer !== null, data.customer);

  const payment = await recordPayment(ctx, {
    orderId: order.id,
    idempotencyKey: data.idempotencyKey,
    method: data.method,
    amount: data.amount,
    amountTendered: data.amountTendered,
    reference: data.reference,
  });

  const { completion, message } = await completeIfAllowed(ctx, order.id, payment);
  const receipts = await listPaymentReceiptJobs(ctx, order.id, payment.transactionId);

  return {
    payment,
    customer,
    completion,
    completionMessage: message,
    receiptQueue: payment.receipt.status,
    receipts: receipts.map(receiptCopyView),
  };
}

/** The live queue status of a payment's receipt copies, for the dialog to poll. */
export async function getPaymentReceipts(ctx: TenantContext, orderId: string, transactionId: string): Promise<ReceiptCopyView[]> {
  return (await listPaymentReceiptJobs(ctx, orderId, transactionId)).map(receiptCopyView);
}

/**
 * Safe receipt retry for one payment. FAILED copies are put back in the queue as the same jobs (no new rows), and if
 * queueing never happened at all the payment's receipt is queued again under its own dedupe keys — so however often
 * this is pressed, a payment has at most one job per copy. Copies that are queued, sending or delivered are left alone.
 * The payment is never touched.
 */
export async function retryPaymentReceipts(ctx: TenantContext, orderId: string, transactionId: string): Promise<ReceiptCopyView[]> {
  // The payment must be this tenant's, on this order; another tenant's id is the same NOT_FOUND as an unknown one.
  const payment = await withTx(ctx, (tx) => findLedgerRow(ctx, tx, transactionId));
  if (!payment || payment.type !== TransactionType.PAYMENT || payment.orderId !== orderId) throw new NotFoundError("Payment not found");
  const order = required(await findOrderDetail(ctx, orderId), "Order");
  if (order.paymentStatus !== PaymentStatus.PAID) {
    throw new ConflictError("The receipt prints once the order is paid in full.", "NOT_SETTLED");
  }

  const jobs = await listPaymentReceiptJobs(ctx, orderId, transactionId);
  if (jobs.length === 0) {
    const outcome = await queueReceiptForPayment(ctx, orderId, transactionId, { printReceipt: true });
    if (outcome.status === "NO_PRINTER") throw new ValidationError("No receipt printer is set up.", undefined, "NO_PRINTER_CONFIGURED");
    if (outcome.status === "FAILED") throw new ConflictError(outcome.error ?? "The receipt could not be queued. Try again.", "RECEIPT_QUEUE_FAILED");
  } else {
    for (const job of jobs) {
      if (job.status === PrintJobStatus.FAILED) await retryPrintJob(ctx, job.id);
    }
  }
  return getPaymentReceipts(ctx, orderId, transactionId);
}
