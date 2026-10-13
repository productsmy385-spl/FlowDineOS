import "server-only";
import { randomUUID } from "node:crypto";
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, TableSessionStatus, TransactionStatus, TransactionType } from "@prisma/client";
import { allocatePayment, billTotals } from "@/lib/billing/table-bill";
import {
  bumpSession,
  findSession,
  findSessionPaymentByKey,
  insertSessionPayment,
  lockSession,
  lockSessionOrders,
  sessionOrders,
  sessionPaymentLedgerRows,
} from "@/lib/data/table-sessions";
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
import { withTx, type Tx } from "@/lib/data/tx";
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

function paymentFieldErrors(input: Pick<RecordPaymentData, "method" | "amount" | "amountTendered" | "reference">): Record<string, string[]> {
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
      // An order on an open table bill is paid with the bill (RASOIOS-ADR-027): paying it alone would print a receipt
      // per order and let the table's bill and its orders be settled twice over.
      if (order.tableSession?.status === TableSessionStatus.OPEN) {
        throw new ConflictError(
          `This order is on the bill for table ${order.tableSession.tableLabel} (${order.tableSession.billNumber}). Take payment on the table bill.`,
          "TABLE_BILL",
          { tableSessionId: order.tableSession.id },
        );
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
      return {
        ...result,
        receipt: await queueReceiptForPayment(ctx, result.orderId, result.transactionId, {
          copies: input.receiptCopies,
          printReceipt: input.printReceipt,
          reference: input.reference,
        }),
      };
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

// ─── Table-bill payments (RASOIOS-ADR-027) ───

export type TableBillPaymentInput = {
  tableSessionId: string;
  /** Client UUID per submit attempt; a repeat returns the original payment (ADR-010 §7). */
  idempotencyKey: string;
  /** The bill version the cashier was looking at. A different version means the bill changed: refused, reload. */
  expectedVersion: number;
  method: PaymentMethod;
  amount: Prisma.Decimal;
  amountTendered?: Prisma.Decimal;
  reference?: string;
};

export type TableBillPaymentResult = {
  paymentId: string;
  tableSessionId: string;
  method: PaymentMethod;
  /** Applied to the bill. */
  amount: MoneyString;
  amountTendered: MoneyString | null;
  changeDue: MoneyString | null;
  /** What the bill still owes after this payment. */
  balance: MoneyString;
  /** The payment settled the bill and closed the session. */
  closed: boolean;
  /** Each order's ledger row: the payment split oldest order first. */
  allocations: Array<{ orderId: string; transactionId: string; amount: MoneyString }>;
  sessionVersion: number;
  replayed: boolean;
};

/**
 * One payment for a whole table bill. In one transaction, under the session's row lock and every order's row lock:
 *
 * 1. a repeated idempotency key returns the original payment (a double click or a lost response never charges twice);
 * 2. the bill must be OPEN and still at the version the cashier saw — an order that joined in between, or another
 *    payment, refuses this one with `BILL_CHANGED` instead of collecting a stale total;
 * 3. the amount rules are the per-order ledger's: no more than the balance, except CASH, where the surplus is change;
 * 4. the money goes into the ledger as one TRANSACTION per order it pays (oldest first), each order's own totals and
 *    payment status recomputed exactly as a per-order payment would — so refunds, day close and reports are unchanged;
 * 5. the bill closes when its balance reaches zero.
 *
 * Receipts and completion happen after the commit (`lib/services/table-sessions.ts`), never inside the money step.
 */
export async function recordTableBillPayment(ctx: TenantContext, input: TableBillPaymentInput): Promise<TableBillPaymentResult> {
  const fieldErrors = paymentFieldErrors(input);
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError("Check the highlighted fields.", fieldErrors);

  const replay = async (): Promise<TableBillPaymentResult | null> =>
    withTx(ctx, async (tx) => {
      const existing = await findSessionPaymentByKey(tx, ctx, input.idempotencyKey);
      if (!existing) return null;
      if (existing.tableSessionId !== input.tableSessionId) throw tableKeyReused();
      return tableBillReplay(tx, ctx, existing);
    });

  try {
    const result = await withTx(ctx, async (tx) => {
      const existing = await findSessionPaymentByKey(tx, ctx, input.idempotencyKey);
      if (existing) {
        if (existing.tableSessionId !== input.tableSessionId) throw tableKeyReused();
        return tableBillReplay(tx, ctx, existing);
      }

      const session = await lockSession(tx, ctx, input.tableSessionId);
      if (!session) throw new NotFoundError("Table bill not found");
      // Re-checked under the lock: a twin submit that was waiting for this lock sees the payment its twin just
      // committed and replays it, instead of reporting the bill it settled as "already closed" or "changed".
      const committed = await findSessionPaymentByKey(tx, ctx, input.idempotencyKey);
      if (committed) {
        if (committed.tableSessionId !== input.tableSessionId) throw tableKeyReused();
        return tableBillReplay(tx, ctx, committed);
      }
      if (session.status !== TableSessionStatus.OPEN) {
        throw new ConflictError(`The bill ${session.billNumber} is already closed.`, "TABLE_BILL_CLOSED");
      }
      if (session.version !== input.expectedVersion) {
        throw new ConflictError("The bill changed while you were looking at it — new items were added or a payment was taken. Review the updated bill.", "BILL_CHANGED", {
          sessionVersion: session.version,
        });
      }
      const orders = await lockSessionOrders(tx, ctx, session.id);

      const businessDate = businessDateFor(now(), ctx.restaurant.timezone);
      if (await findDayClose(tx, ctx, businessDate)) {
        throw new ConflictError("The business day is closed. Reopen it or record this on the current day.", "DAY_CLOSED");
      }

      const outstanding = billTotals(orders).balance;
      if (outstanding.lte(0)) {
        throw new LedgerRuleError("AMOUNT_EXCEEDS_BALANCE", "This bill has no balance left to pay.", { amount: ["Nothing is outstanding on this bill"] });
      }

      let amount = input.amount;
      let amountTendered: Prisma.Decimal | null = null;
      let changeDue: Prisma.Decimal | null = null;
      if (input.method === PaymentMethod.CASH) {
        amountTendered = input.amountTendered ?? input.amount;
        amount = Prisma.Decimal.min(input.amount, outstanding);
        changeDue = amountTendered.minus(amount);
      } else if (input.amount.gt(outstanding)) {
        throw new LedgerRuleError("AMOUNT_EXCEEDS_BALANCE", `The amount exceeds the bill's outstanding balance of ${moneyDto(outstanding)}.`, {
          amount: [`At most ${moneyDto(outstanding)}`],
        });
      }

      const payment = await insertSessionPayment(tx, ctx, {
        tableSessionId: session.id,
        idempotencyKey: input.idempotencyKey,
        paymentMethod: input.method,
        amount,
        amountTendered,
        changeDue,
        reference: input.reference ?? null,
        businessDate,
      });

      const byId = new Map(orders.map((o) => [o.id, o]));
      const allocations: TableBillPaymentResult["allocations"] = [];
      for (const part of allocatePayment(orders, amount)) {
        const order = byId.get(part.orderId)!;
        const paidAmount = order.paidAmount.plus(part.amount);
        const paymentStatus = derivePaymentStatus(order.totalAmount, paidAmount, order.refundedAmount);
        if (!(await updateOrderLedgerTotals(ctx, tx, order, { paidAmount, paymentStatus }))) throw orderChanged();
        const row = await insertLedgerRow(ctx, tx, {
          orderId: order.id,
          type: TransactionType.PAYMENT,
          paymentMethod: input.method,
          amount: part.amount,
          reference: input.reference ?? null,
          businessDate,
          // Each ledger row needs its own key; the payment's key is on the table payment row and is what replays.
          idempotencyKey: randomUUID(),
          tableSessionPaymentId: payment.id,
        });
        await audit(tx, ctx, {
          action: "payment.recorded",
          resourceType: "transaction",
          resourceId: row.id,
          before: { orderId: order.id, paymentStatus: order.paymentStatus, paidAmount: moneyDto(order.paidAmount) },
          after: { orderId: order.id, method: input.method, amount: moneyDto(part.amount), paymentStatus, paidAmount: moneyDto(paidAmount), tableSessionPaymentId: payment.id },
        });
        allocations.push({ orderId: order.id, transactionId: row.id, amount: moneyDto(part.amount) });
      }

      const balance = outstanding.minus(amount);
      const closed = balance.lte(0);
      if (!(await bumpSession(tx, ctx, session, closed ? { at: now() } : null))) throw orderChanged();

      await audit(tx, ctx, {
        action: "table_session.payment_recorded",
        resourceType: "table_session_payment",
        resourceId: payment.id,
        before: { tableSessionId: session.id, billNumber: session.billNumber, balance: moneyDto(outstanding) },
        after: {
          tableSessionId: session.id,
          method: input.method,
          amount: moneyDto(amount),
          amountTendered: nullableMoneyDto(amountTendered),
          changeDue: nullableMoneyDto(changeDue),
          balance: moneyDto(balance),
          orders: allocations.map((a) => ({ orderId: a.orderId, amount: a.amount })),
        },
      });
      if (closed) {
        await audit(tx, ctx, {
          action: "table_session.closed",
          resourceType: "table_session",
          resourceId: session.id,
          before: { status: TableSessionStatus.OPEN },
          after: { status: TableSessionStatus.CLOSED, billNumber: session.billNumber, trigger: "settled" },
        });
      }

      return {
        paymentId: payment.id,
        tableSessionId: session.id,
        method: input.method,
        amount: moneyDto(amount),
        amountTendered: nullableMoneyDto(amountTendered),
        changeDue: nullableMoneyDto(changeDue),
        balance: moneyDto(balance),
        closed,
        allocations,
        sessionVersion: session.version + 1,
        replayed: false,
      } satisfies TableBillPaymentResult;
    });

    if (!result.replayed) {
      logger.info("table_session.payment_recorded", { requestId: ctx.requestId, tenantId: ctx.tenantId, tableSessionId: result.tableSessionId, paymentId: result.paymentId, amount: result.amount, closed: result.closed });
    }
    return result;
  } catch (error) {
    // Two submits with one key raced past the key check: the loser hits UNIQUE (tenant_id, idempotency_key).
    if (error instanceof ConflictError && (error.code === "CONFLICT" || error.code === "ORDER_CHANGED")) {
      const replayed = await replay();
      if (replayed) return replayed;
    }
    throw error;
  }
}

function tableKeyReused(): ConflictError {
  return new ConflictError("This request id was already used for a different bill. Reload and try again.", "IDEMPOTENCY_KEY_REUSED");
}

/** The original result of a table payment, rebuilt for a repeated key from what was committed. */
async function tableBillReplay(
  tx: Tx,
  ctx: TenantContext,
  payment: NonNullable<Awaited<ReturnType<typeof findSessionPaymentByKey>>>,
): Promise<TableBillPaymentResult> {
  const session = await findSession(tx, ctx, payment.tableSessionId);
  const orders = await sessionOrders(tx, ctx, payment.tableSessionId);
  const rows = await sessionPaymentLedgerRows(tx, ctx, payment.id);
  return {
    paymentId: payment.id,
    tableSessionId: payment.tableSessionId,
    method: payment.paymentMethod,
    amount: moneyDto(payment.amount),
    amountTendered: nullableMoneyDto(payment.amountTendered),
    changeDue: nullableMoneyDto(payment.changeDue),
    balance: moneyDto(billTotals(orders).balance),
    closed: session?.status === TableSessionStatus.CLOSED,
    allocations: rows.map((r) => ({ orderId: r.orderId, transactionId: r.id, amount: moneyDto(r.amount) })),
    sessionVersion: session?.version ?? 0,
    replayed: true,
  };
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
