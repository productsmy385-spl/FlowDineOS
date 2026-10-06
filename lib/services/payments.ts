import "server-only";
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, TransactionStatus, TransactionType } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { audit } from "@/lib/audit/write";
import { moneyDto, nullableMoneyDto, type MoneyString } from "@/lib/data/dto";
import {
  findLedgerRow,
  findLedgerRowByIdempotencyKey,
  insertLedgerRow,
  lockOrderForLedger,
  readLedgerOrder,
  sumRefundsOfPayment,
  updateOrderLedgerTotals,
  type LedgerOrder,
  type LedgerRow,
} from "@/lib/data/payments";
import { findDayClose } from "@/lib/data/day-close";
import { withTx } from "@/lib/data/tx";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { statusAfterRefund } from "@/lib/services/orders";
import { queueReceiptForPayment, type ReceiptQueueOutcome } from "@/lib/services/printing";
import { businessDateFor, now } from "@/lib/time";
import type { CreateRefundData, RecordPaymentData } from "@/lib/validation/payments";

/**
 * Payment ledger service (S1-P04-T007; ADR-010 §7–8, INV-04, api.md SA-TXN-01/02).
 *
 * - The tenant and the recording user come from `ctx` only. Orders and payments are looked up tenant-scoped, so a
 *   missing id and another tenant's id both end in the same NotFoundError.
 * - The order row is locked for the whole transaction; the ledger row, the recomputed `paid_amount` /
 *   `refunded_amount` / `payment_status` and the audit row commit together or not at all.
 * - A payment may not exceed the outstanding balance (total − paid + refunded), except CASH, where the amount applied
 *   is capped at the balance and the surplus is recorded as change. Refunds may not exceed what was paid on that
 *   payment, nor what the order has left to refund.
 * - A repeated idempotency key returns the original ledger row instead of recording a second one.
 */

/** A ledger rule violation (422) with a specific, stable error code. */
export class LedgerRuleError extends ValidationError {
  constructor(code: "AMOUNT_EXCEEDS_BALANCE" | "REFUND_EXCEEDS_PAID", message: string, fieldErrors?: Record<string, string[]>) {
    super(message, fieldErrors, code);
  }
}

/** `ORDER.payment_status`, derived from the ledger totals (never client-set; data-model E14). */
export function derivePaymentStatus(total: Prisma.Decimal, paid: Prisma.Decimal, refunded: Prisma.Decimal): PaymentStatus {
  if (refunded.gt(0)) return refunded.gte(paid) ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
  if (paid.lte(0)) return PaymentStatus.UNPAID;
  return paid.gte(total) ? PaymentStatus.PAID : PaymentStatus.PARTIALLY_PAID;
}

function outstandingOf(order: Pick<LedgerOrder, "totalAmount" | "paidAmount" | "refundedAmount">): Prisma.Decimal {
  return order.totalAmount.minus(order.paidAmount).plus(order.refundedAmount);
}

function orderChanged(): ConflictError {
  return new ConflictError("The order was changed by someone else. Reload and try again.", "ORDER_CHANGED");
}

function idempotencyKeyReused(): ConflictError {
  return new ConflictError("This request id was already used for a different payment. Reload and try again.", "IDEMPOTENCY_KEY_REUSED");
}

// ─── Payments (SA-TXN-01) ───

export type PaymentResult = {
  transactionId: string;
  orderId: string;
  method: PaymentMethod;
  /** Amount applied to the order. */
  amount: MoneyString;
  amountTendered: MoneyString | null;
  changeDue: MoneyString | null;
  paymentStatus: PaymentStatus;
  paidAmount: MoneyString;
  /** What is still outstanding on the order after this payment. */
  balance: MoneyString;
  /** True when this call replayed an earlier submit with the same idempotency key. */
  replayed: boolean;
  /** The receipt this payment queued, if it settled the bill (see `queueReceiptForPayment`). */
  receipt: ReceiptQueueOutcome;
};

function paymentResult(row: LedgerRow, order: Pick<LedgerOrder, "paymentStatus" | "totalAmount" | "paidAmount" | "refundedAmount">, replayed: boolean): PaymentResult {
  return {
    transactionId: row.id,
    orderId: row.orderId,
    method: row.paymentMethod,
    amount: moneyDto(row.amount),
    amountTendered: nullableMoneyDto(row.amountTendered),
    changeDue: nullableMoneyDto(row.changeDue),
    paymentStatus: order.paymentStatus,
    paidAmount: moneyDto(order.paidAmount),
    balance: moneyDto(outstandingOf(order)),
    replayed,
    receipt: { status: "NOT_REQUESTED" },
  };
}

function paymentFieldErrors(input: RecordPaymentData): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (input.amountTendered !== undefined) {
    if (input.method !== PaymentMethod.CASH) errors.amountTendered = ["Amount tendered applies to cash payments only"];
    else if (input.amountTendered.lt(input.amount)) errors.amountTendered = ["Amount tendered must cover the amount"];
  }
  if (input.method === PaymentMethod.UPI && !input.reference) errors.reference = ["Enter the UPI reference"];
  return errors;
}

/** Replays a payment for a repeated idempotency key; null when the key belongs to something else. */
async function replayPayment(ctx: TenantContext, idempotencyKey: string, orderId: string): Promise<PaymentResult | null> {
  return withTx(ctx, async (tx) => {
    const existing = await findLedgerRowByIdempotencyKey(ctx, tx, idempotencyKey);
    if (!existing || existing.type !== TransactionType.PAYMENT || existing.orderId !== orderId) return null;
    const order = await readLedgerOrder(ctx, tx, orderId);
    return order ? paymentResult(existing, order, true) : null;
  });
}

export async function recordPayment(ctx: TenantContext, input: RecordPaymentData): Promise<PaymentResult> {
  const fieldErrors = paymentFieldErrors(input);
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError("Check the highlighted fields.", fieldErrors);

  try {
    const result = await withTx(ctx, async (tx) => {
      const order = await lockOrderForLedger(ctx, tx, input.orderId);
      if (!order) throw new NotFoundError("Order not found");

      const existing = await findLedgerRowByIdempotencyKey(ctx, tx, input.idempotencyKey);
      if (existing) {
        if (existing.type !== TransactionType.PAYMENT || existing.orderId !== order.id) throw idempotencyKeyReused();
        return paymentResult(existing, order, true);
      }

      if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
        throw new ConflictError(`A ${order.status.toLowerCase()} order cannot take payments.`, "ORDER_NOT_PAYABLE");
      }

      // A closed business day is a harder stop than any amount rule, so it is checked first (SA-TXN-04).
      const businessDate = businessDateFor(now(), ctx.restaurant.timezone);
      if (await findDayClose(tx, ctx, businessDate)) {
        throw new ConflictError("The business day is closed. Reopen it or record this on the current day.", "DAY_CLOSED");
      }

      const outstanding = outstandingOf(order);
      if (outstanding.lte(0)) {
        throw new LedgerRuleError("AMOUNT_EXCEEDS_BALANCE", "This order has no balance left to pay.", { amount: ["Nothing is outstanding on this order"] });
      }

      let amount = input.amount;
      let amountTendered: Prisma.Decimal | null = null;
      let changeDue: Prisma.Decimal | null = null;
      if (input.method === PaymentMethod.CASH) {
        // Cash may exceed the balance: apply at most the balance and record the rest as change (ADR-010 §8).
        amountTendered = input.amountTendered ?? input.amount;
        amount = Prisma.Decimal.min(input.amount, outstanding);
        changeDue = amountTendered.minus(amount);
      } else if (input.amount.gt(outstanding)) {
        throw new LedgerRuleError("AMOUNT_EXCEEDS_BALANCE", `The amount exceeds the outstanding balance of ${moneyDto(outstanding)}.`, {
          amount: [`At most ${moneyDto(outstanding)}`],
        });
      }

      const paidAmount = order.paidAmount.plus(amount);
      const paymentStatus = derivePaymentStatus(order.totalAmount, paidAmount, order.refundedAmount);
      // A payment never changes the order status: staff complete a READY order once it is PAID (BR-ORD-06, Q-007 A).
      const updated = await updateOrderLedgerTotals(ctx, tx, order, { paidAmount, paymentStatus });
      if (!updated) throw orderChanged();

      const row = await insertLedgerRow(ctx, tx, {
        orderId: order.id,
        type: TransactionType.PAYMENT,
        paymentMethod: input.method,
        amount,
        amountTendered,
        changeDue,
        reference: input.reference ?? null,
        businessDate,
        idempotencyKey: input.idempotencyKey,
      });

      await audit(tx, ctx, {
        action: "payment.recorded",
        resourceType: "transaction",
        resourceId: row.id,
        before: { orderId: order.id, paymentStatus: order.paymentStatus, paidAmount: moneyDto(order.paidAmount) },
        after: {
          orderId: order.id,
          method: input.method,
          amount: moneyDto(amount),
          amountTendered: nullableMoneyDto(amountTendered),
          changeDue: nullableMoneyDto(changeDue),
          paymentStatus,
          paidAmount: moneyDto(paidAmount),
        },
      });

      return paymentResult(row, { paymentStatus, totalAmount: order.totalAmount, paidAmount, refundedAmount: order.refundedAmount }, false);
    });

    if (!result.replayed) {
      logger.info("payment.recorded", { requestId: ctx.requestId, transactionId: result.transactionId, orderId: result.orderId, method: result.method, amount: result.amount });
    }
    // The bill is settled: print the receipt on the restaurant's receipt printer (owner brief 2026-10-06 §15). Only
    // after the payment has committed, only when it settles the bill, and never for a replayed submit — a double click
    // replays the same payment, and the job is keyed to that payment, so it cannot print twice.
    if (!result.replayed && result.paymentStatus === PaymentStatus.PAID) {
      return { ...result, receipt: await queueReceiptForPayment(ctx, result.orderId, result.transactionId) };
    }
    return result;
  } catch (error) {
    // Two submits with one key raced past the key check: the loser hits UNIQUE (tenant_id, idempotency_key).
    if (error instanceof ConflictError && (error.code === "CONFLICT" || error.code === "ORDER_CHANGED")) {
      const replay = await replayPayment(ctx, input.idempotencyKey, input.orderId);
      if (replay) return replay;
    }
    throw error;
  }
}

// ─── Refunds (SA-TXN-02) ───

export type RefundResult = {
  transactionId: string;
  orderId: string;
  paymentTransactionId: string;
  method: PaymentMethod;
  amount: MoneyString;
  paymentStatus: PaymentStatus;
  refundedAmount: MoneyString;
  replayed: boolean;
};

function refundResult(row: LedgerRow, order: Pick<LedgerOrder, "paymentStatus" | "refundedAmount">, replayed: boolean): RefundResult {
  return {
    transactionId: row.id,
    orderId: row.orderId,
    paymentTransactionId: row.refundOfTransactionId ?? "",
    method: row.paymentMethod,
    amount: moneyDto(row.amount),
    paymentStatus: order.paymentStatus,
    refundedAmount: moneyDto(order.refundedAmount),
    replayed,
  };
}

async function replayRefund(ctx: TenantContext, idempotencyKey: string, paymentTransactionId: string): Promise<RefundResult | null> {
  return withTx(ctx, async (tx) => {
    const existing = await findLedgerRowByIdempotencyKey(ctx, tx, idempotencyKey);
    if (!existing || existing.type !== TransactionType.REFUND || existing.refundOfTransactionId !== paymentTransactionId) return null;
    const order = await readLedgerOrder(ctx, tx, existing.orderId);
    return order ? refundResult(existing, order, true) : null;
  });
}

export async function createRefund(ctx: TenantContext, input: CreateRefundData): Promise<RefundResult> {
  try {
    const result = await withTx(ctx, async (tx) => {
      const payment = await findLedgerRow(ctx, tx, input.paymentTransactionId);
      if (!payment) throw new NotFoundError("Payment not found");

      const order = await lockOrderForLedger(ctx, tx, payment.orderId);
      if (!order) throw new NotFoundError("Payment not found");

      const existing = await findLedgerRowByIdempotencyKey(ctx, tx, input.idempotencyKey);
      if (existing) {
        if (existing.type !== TransactionType.REFUND || existing.refundOfTransactionId !== payment.id) throw idempotencyKeyReused();
        return refundResult(existing, order, true);
      }

      if (payment.type !== TransactionType.PAYMENT || payment.status !== TransactionStatus.SUCCESS) {
        throw new ConflictError("Only a successful payment can be refunded.", "NOT_REFUNDABLE");
      }

      // A closed business day is a harder stop than any amount rule, so it is checked first (SA-TXN-04).
      const businessDate = businessDateFor(now(), ctx.restaurant.timezone);
      if (await findDayClose(tx, ctx, businessDate)) {
        throw new ConflictError("The business day is closed. Reopen it or record this on the current day.", "DAY_CLOSED");
      }

      const alreadyRefunded = await sumRefundsOfPayment(ctx, tx, payment.id);
      const refundable = Prisma.Decimal.min(payment.amount.minus(alreadyRefunded), order.paidAmount.minus(order.refundedAmount));
      const amount = input.amount ?? refundable;
      if (refundable.lte(0)) {
        throw new LedgerRuleError("REFUND_EXCEEDS_PAID", "This payment has already been refunded in full.", { amount: ["Nothing is left to refund"] });
      }
      if (amount.gt(refundable)) {
        throw new LedgerRuleError("REFUND_EXCEEDS_PAID", `The refund exceeds the refundable amount of ${moneyDto(refundable)}.`, {
          amount: [`At most ${moneyDto(refundable)}`],
        });
      }

      const at = now();
      const refundedAmount = order.refundedAmount.plus(amount);
      const paymentStatus = derivePaymentStatus(order.totalAmount, order.paidAmount, refundedAmount);
      // api.md SA-TXN-02: a full refund of a COMPLETED order moves it to REFUNDED (rule owned by the order service).
      const refundsOrder = statusAfterRefund(order, refundedAmount) === OrderStatus.REFUNDED;

      const updated = await updateOrderLedgerTotals(ctx, tx, order, {
        refundedAmount,
        paymentStatus,
        ...(refundsOrder ? { status: OrderStatus.REFUNDED, refundedAt: at } : {}),
      });
      if (!updated) throw orderChanged();

      const row = await insertLedgerRow(ctx, tx, {
        orderId: order.id,
        type: TransactionType.REFUND,
        paymentMethod: payment.paymentMethod,
        amount,
        refundOfTransactionId: payment.id,
        reason: input.reason,
        businessDate,
        idempotencyKey: input.idempotencyKey,
      });

      await audit(tx, ctx, {
        action: "refund.created",
        resourceType: "transaction",
        resourceId: row.id,
        reason: input.reason,
        before: { orderId: order.id, paymentStatus: order.paymentStatus, refundedAmount: moneyDto(order.refundedAmount) },
        after: {
          orderId: order.id,
          refundOfTransactionId: payment.id,
          method: payment.paymentMethod,
          amount: moneyDto(amount),
          paymentStatus,
          refundedAmount: moneyDto(refundedAmount),
        },
      });
      if (refundsOrder) {
        await audit(tx, ctx, {
          action: "order.status_changed",
          resourceType: "order",
          resourceId: order.id,
          before: { status: order.status },
          after: { status: OrderStatus.REFUNDED, trigger: "fully_refunded" },
        });
      }

      return refundResult(row, { paymentStatus, refundedAmount }, false);
    });

    if (!result.replayed) {
      logger.info("refund.created", { requestId: ctx.requestId, transactionId: result.transactionId, orderId: result.orderId, amount: result.amount });
    }
    return result;
  } catch (error) {
    if (error instanceof ConflictError && (error.code === "CONFLICT" || error.code === "ORDER_CHANGED")) {
      const replay = await replayRefund(ctx, input.idempotencyKey, input.paymentTransactionId);
      if (replay) return replay;
    }
    throw error;
  }
}
