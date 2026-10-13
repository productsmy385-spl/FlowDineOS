import "server-only";
import { OrderStatus, PaymentStatus, PrintJobStatus, TableSessionStatus, TransactionType, type KotStatus, type PaymentMethod } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { hasPermission } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit/write";
import { billTotals, groupBillLines, isBilled, outstandingOf, tableKeyOf, type BillTotals } from "@/lib/billing/table-bill";
import { findCustomerByPhone } from "@/lib/data/customers";
import { moneyDto, nullableMoneyDto, rateDto, type MoneyString } from "@/lib/data/dto";
import { listTableBillReceiptJobs } from "@/lib/data/printing";
import { required } from "@/lib/data/scope";
import {
  bumpSession,
  findOpenSessionOfTable,
  findSession,
  findSessionPayment,
  listOpenSessions,
  lockSession,
  lockSessionOrders,
  sessionOrders,
  sessionPayments,
  type SessionOrder,
  type SessionRow,
} from "@/lib/data/table-sessions";
import { withTx } from "@/lib/data/tx";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createCustomer } from "@/lib/services/customers";
import { setOrderCustomer } from "@/lib/services/orders";
import { recordTableBillPayment, type TableBillPaymentResult } from "@/lib/services/payments";
import { queueTableBillReceipt, retryPrintJob, type ReceiptQueueOutcome } from "@/lib/services/printing";
import { completeOrderIfReady, receiptCopyView, type CompletionOutcome, type ReceiptCopyView } from "@/lib/services/simplified-workflow";
import { now } from "@/lib/time";
import type { PayTableBillData } from "@/lib/validation/table-sessions";

/**
 * Table bills (RASOIOS-ADR-027): one bill per dine-in party at a table, however many times they order.
 *
 * - Each order keeps its own lines, KOTs, kitchen lifecycle and ledger; the session only groups them for billing.
 * - Joining happens inside the order's own transaction under the session's row lock (`placeOrderOnTableBill`).
 * - Paying happens in the ledger service (`recordTableBillPayment`) under the same lock, against the bill version the
 *   cashier saw. Completion, receipts and the customer are handled here around that money step, never inside it.
 * - Takeaway, delivery and orders without a table never get a session, and nothing is merged by name or phone.
 */

// ─── Reading a bill ───

export type TableBillState = "OPEN" | "PREPARING" | "READY" | "PARTIALLY_PAID" | "PAYMENT_PENDING" | "SETTLED" | "CLOSED";

export type TableBillView = {
  id: string;
  billNumber: string;
  tableLabel: string;
  status: TableSessionStatus;
  /** What staff see: OPEN, PREPARING, READY, PARTIALLY_PAID, PAYMENT_PENDING, SETTLED or CLOSED. */
  state: TableBillState;
  version: number;
  openedAt: string;
  closedAt: string | null;
  currencyCode: string;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    billed: boolean;
    total: MoneyString;
    balance: MoneyString;
    createdAt: string;
    kots: Array<{ kotNumber: string; status: KotStatus; round: number }>;
  }>;
  lines: Array<{
    name: string;
    quantity: number;
    unitPrice: MoneyString;
    taxRate: string;
    lineSubtotal: MoneyString;
    lineTax: MoneyString;
    lineTotal: MoneyString;
    orders: string[];
  }>;
  totals: { subtotal: MoneyString; tax: MoneyString; discount: MoneyString; total: MoneyString; paid: MoneyString; refunded: MoneyString; balance: MoneyString };
  payments: Array<{
    id: string;
    method: PaymentMethod;
    amount: MoneyString;
    amountTendered: MoneyString | null;
    changeDue: MoneyString | null;
    reference: string | null;
    createdAt: string;
    active: boolean;
  }>;
  /** Customers already on the bill's orders (distinct). Empty means the bill is anonymous so far. */
  customers: Array<{ name: string; phone: string | null }>;
  /** Every billed order is READY/COMPLETED, nothing owed: a payment would complete them. */
  canClose: boolean;
};

const IN_KITCHEN = new Set<OrderStatus>([OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PREPARING]);

function stateOf(session: SessionRow, orders: readonly SessionOrder[], totals: BillTotals): TableBillState {
  if (session.status === TableSessionStatus.CLOSED) return totals.total.gt(0) && totals.balance.lte(0) ? "SETTLED" : "CLOSED";
  const billed = orders.filter((o) => isBilled(o.status));
  if (totals.paid.gt(0) && totals.balance.gt(0)) return "PARTIALLY_PAID";
  if (billed.length === 0) return "OPEN";
  if (billed.some((o) => IN_KITCHEN.has(o.status))) return billed.some((o) => o.status === OrderStatus.PREPARING) ? "PREPARING" : "OPEN";
  return totals.balance.gt(0) ? "PAYMENT_PENDING" : "READY";
}

function toView(ctx: TenantContext, session: SessionRow, orders: SessionOrder[], payments: Awaited<ReturnType<typeof sessionPayments>>): TableBillView {
  const totals = billTotals(orders);
  const customers = new Map<string, { name: string; phone: string | null }>();
  for (const o of orders) if (o.customer) customers.set(o.customer.id, { name: o.customer.name, phone: o.customer.phone });
  return {
    id: session.id,
    billNumber: session.billNumber,
    tableLabel: session.tableLabel,
    status: session.status,
    state: stateOf(session, orders, totals),
    version: session.version,
    openedAt: session.openedAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    currencyCode: ctx.restaurant.currencyCode,
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      billed: isBilled(o.status),
      total: moneyDto(o.totalAmount),
      // A cancelled or refunded order is listed but owes nothing on this bill.
      balance: isBilled(o.status) ? moneyDto(outstandingOf(o)) : "0.00",
      createdAt: o.createdAt.toISOString(),
      kots: o.kots.map((k) => ({ kotNumber: k.kotNumber, status: k.status, round: k.round })),
    })),
    lines: groupBillLines(orders).map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPrice: moneyDto(line.unitPrice),
      taxRate: rateDto(line.taxRate),
      lineSubtotal: moneyDto(line.lineSubtotal),
      lineTax: moneyDto(line.lineTax),
      lineTotal: moneyDto(line.lineTotal),
      orders: [...new Set(line.sources.map((s) => s.orderNumber))],
    })),
    totals: {
      subtotal: moneyDto(totals.subtotal),
      tax: moneyDto(totals.tax),
      discount: moneyDto(totals.discount),
      total: moneyDto(totals.total),
      paid: moneyDto(totals.paid),
      refunded: moneyDto(totals.refunded),
      balance: moneyDto(totals.balance),
    },
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: moneyDto(p.amount),
      amountTendered: nullableMoneyDto(p.amountTendered),
      changeDue: nullableMoneyDto(p.changeDue),
      reference: p.reference,
      createdAt: p.createdAt.toISOString(),
      active: p.active,
    })),
    customers: [...customers.values()],
    canClose: session.status === TableSessionStatus.OPEN && totals.balance.lte(0),
  };
}

/** One bill as it is right now. Missing and other-tenant ids are both NOT_FOUND. */
export async function getTableBill(ctx: TenantContext, sessionId: string): Promise<TableBillView> {
  return withTx(ctx, async (tx) => {
    const session = await findSession(tx, ctx, sessionId);
    if (!session) throw new NotFoundError("Table bill not found");
    return toView(ctx, session, await sessionOrders(tx, ctx, session.id), await sessionPayments(tx, ctx, session.id));
  });
}

export type OpenTableBill = { id: string; billNumber: string; tableLabel: string; state: TableBillState; orderCount: number; balance: MoneyString; total: MoneyString; openedAt: string };

/** Every open bill, for the Orders board. */
export async function listOpenTableBills(ctx: TenantContext): Promise<OpenTableBill[]> {
  const rows = await listOpenSessions(ctx);
  return rows.map((row) => {
    const totals = billTotals(row.orders);
    return {
      id: row.id,
      billNumber: row.billNumber,
      tableLabel: row.tableLabel,
      state: stateOf(row, row.orders, totals),
      orderCount: row.orderCount,
      balance: moneyDto(totals.balance),
      total: moneyDto(totals.total),
      openedAt: row.openedAt.toISOString(),
    };
  });
}

/** Order entry: the open bill a new dine-in order for `tableLabel` would join, or null when it would open one. */
export async function lookupTableBill(ctx: TenantContext, tableLabel: string): Promise<{ id: string; billNumber: string; tableLabel: string; orderCount: number; balance: MoneyString } | null> {
  const session = await findOpenSessionOfTable(ctx, tableKeyOf(tableLabel));
  if (!session) return null;
  const orders = await withTx(ctx, (tx) => sessionOrders(tx, ctx, session.id));
  return { id: session.id, billNumber: session.billNumber, tableLabel: session.tableLabel, orderCount: orders.length, balance: moneyDto(billTotals(orders).balance) };
}

// ─── Paying the bill ───

export type TableBillSettlement = {
  payment: TableBillPaymentResult;
  customer: "KEPT" | "LINKED" | "CREATED" | "NONE";
  /** Per order, what completion did after the payment (only attempted when the bill is settled). */
  completions: Array<{ orderId: string; orderNumber: string; completion: CompletionOutcome; message: string | null }>;
  receiptQueue: ReceiptQueueOutcome["status"];
  receipts: ReceiptCopyView[];
  bill: TableBillView;
};

/**
 * Record Payment for a table: optional customer (only onto orders that have none) → the ledger payment (idempotent,
 * version-checked, all-or-nothing) → when the bill is settled: complete each READY order through the state machine
 * and queue the one consolidated receipt. A printing problem is reported next to the payment, never instead of it.
 */
export async function payTableBill(ctx: TenantContext, data: PayTableBillData): Promise<TableBillSettlement> {
  const before = await getTableBill(ctx, data.tableSessionId);
  const customer = await attachBillCustomer(ctx, before, data.customer);

  const payment = await recordTableBillPayment(ctx, {
    tableSessionId: data.tableSessionId,
    idempotencyKey: data.idempotencyKey,
    // Attaching a customer moved no money and no bill line, so the cashier's version still stands.
    expectedVersion: data.expectedVersion,
    method: data.method,
    amount: data.amount,
    amountTendered: data.amountTendered,
    reference: data.reference,
  });

  const completions: TableBillSettlement["completions"] = [];
  let receiptQueue: ReceiptQueueOutcome["status"] = "NOT_REQUESTED";
  if (payment.closed) {
    const bill = await getTableBill(ctx, data.tableSessionId);
    for (const order of bill.orders.filter((o) => o.billed && o.status !== OrderStatus.COMPLETED)) {
      completions.push({ orderNumber: order.orderNumber, orderId: order.id, ...(await completeOrderIfReady(ctx, order.id)) });
    }
    if (!payment.replayed) receiptQueue = (await queueTableBillReceipt(ctx, payment.paymentId, await receiptFor(ctx, data.tableSessionId))).status;
  }

  return {
    payment,
    customer,
    completions,
    receiptQueue,
    receipts: (await listTableBillReceiptJobs(ctx, payment.paymentId)).map(receiptCopyView),
    bill: await getTableBill(ctx, data.tableSessionId),
  };
}

/**
 * The customer on the bill: if any order already has one, nothing is changed (BR-CUST-02). Otherwise a phone that
 * belongs to a known customer links that customer as stored, and a new name creates one — linked to every order of the
 * bill that has none. Never by name or phone alone across tables: only this bill's own orders are touched.
 */
async function attachBillCustomer(ctx: TenantContext, bill: TableBillView, input: PayTableBillData["customer"]): Promise<TableBillSettlement["customer"]> {
  if (bill.customers.length > 0) return "KEPT";
  if (!input) return "NONE";
  if (bill.status !== TableSessionStatus.OPEN) return "NONE";

  let customerId: string | null = null;
  let outcome: TableBillSettlement["customer"] = "NONE";
  if (input.phone) {
    const match = await withTx(ctx, (tx) => findCustomerByPhone(tx, ctx, input.phone!));
    if (match) {
      if (!hasPermission(ctx, "customer:read")) throw new ForbiddenError("You can't attach an existing customer to an order.");
      customerId = match.id;
      outcome = "LINKED";
    }
  }
  if (!customerId) {
    if (!input.name) throw new ValidationError("Check the highlighted fields.", { "customer.name": ["Enter the customer's name, or leave both fields empty"] });
    if (!hasPermission(ctx, "customer:create")) throw new ForbiddenError("You can't add a new customer. Leave the customer fields empty or ask a manager.");
    customerId = (await createCustomer(ctx, { fullName: input.name, phoneE164: input.phone ?? null, email: null, notes: null })).id;
    outcome = "CREATED";
  }
  for (const order of bill.orders) await setOrderCustomer(ctx, { orderId: order.id, customerId });
  return outcome;
}

/** The consolidated receipt's content: the billed orders' lines and snapshot totals, and the bill's own payments. */
async function receiptFor(ctx: TenantContext, sessionId: string): Promise<Parameters<typeof queueTableBillReceipt>[2]> {
  return withTx(ctx, async (tx) => {
    const session = required(await findSession(tx, ctx, sessionId), "Table bill");
    const orders = await sessionOrders(tx, ctx, sessionId);
    const payments = (await sessionPayments(tx, ctx, sessionId)).filter((p) => p.active);
    const totals = billTotals(orders);
    const customer = orders.find((o) => o.customer)?.customer ?? null;
    return {
      billNumber: session.billNumber,
      tableLabel: session.tableLabel,
      orderNumbers: orders.filter((o) => isBilled(o.status)).map((o) => o.orderNumber),
      openedAt: session.openedAt,
      customerName: customer?.name ?? null,
      items: groupBillLines(orders).map((line) => ({
        quantity: line.quantity,
        label: line.name,
        taxRate: rateDto(line.taxRate),
        lineSubtotal: moneyDto(line.lineSubtotal),
        lineTax: moneyDto(line.lineTax),
        lineTotal: moneyDto(line.lineTotal),
      })),
      totals: {
        subtotal: moneyDto(totals.subtotal),
        tax: moneyDto(totals.tax),
        discount: moneyDto(totals.discount),
        total: moneyDto(totals.total),
        paid: moneyDto(totals.paid),
        refunded: moneyDto(totals.refunded),
        balance: moneyDto(totals.balance),
      },
      ledger: payments.map((p) => ({
        type: TransactionType.PAYMENT,
        method: p.method,
        amount: moneyDto(p.amount),
        amountTendered: nullableMoneyDto(p.amountTendered),
        changeDue: nullableMoneyDto(p.changeDue),
      })),
    };
  });
}

// ─── Receipt status and retry ───

async function settledPaymentOf(ctx: TenantContext, paymentId: string): Promise<{ sessionId: string }> {
  const payment = await withTx(ctx, (tx) => findSessionPayment(tx, ctx, paymentId));
  if (!payment) throw new NotFoundError("Payment not found");
  return { sessionId: payment.tableSessionId };
}

export async function getTableBillReceipts(ctx: TenantContext, paymentId: string): Promise<ReceiptCopyView[]> {
  await settledPaymentOf(ctx, paymentId);
  return (await listTableBillReceiptJobs(ctx, paymentId)).map(receiptCopyView);
}

/**
 * Safe retry: FAILED copies go back in the queue as the same jobs; if none were ever queued (no printer then, automatic
 * receipts off, or queueing failed), the receipt is queued under the payment's own dedupe keys. Never a new payment,
 * never a duplicate copy. Only for a settled bill — a part payment prints nothing.
 */
export async function retryTableBillReceipts(ctx: TenantContext, paymentId: string): Promise<ReceiptCopyView[]> {
  const { sessionId } = await settledPaymentOf(ctx, paymentId);
  const bill = await getTableBill(ctx, sessionId);
  if (bill.state !== "SETTLED") throw new ConflictError("The receipt prints once the bill is paid in full.", "NOT_SETTLED");

  const jobs = await listTableBillReceiptJobs(ctx, paymentId);
  if (jobs.length === 0) {
    const outcome = await queueTableBillReceipt(ctx, paymentId, await receiptFor(ctx, sessionId), { printReceipt: true });
    if (outcome.status === "NO_PRINTER") throw new ValidationError("No receipt printer is set up.", undefined, "NO_PRINTER_CONFIGURED");
    if (outcome.status === "FAILED") throw new ConflictError(outcome.error ?? "The receipt could not be queued. Try again.", "RECEIPT_QUEUE_FAILED");
  } else {
    for (const job of jobs) if (job.status === PrintJobStatus.FAILED) await retryPrintJob(ctx, job.id);
  }
  return (await listTableBillReceiptJobs(ctx, paymentId)).map(receiptCopyView);
}

// ─── Closing without a payment ───

/**
 * Closes an open bill that owes nothing (e.g. every order on it was cancelled), at the version the person saw. A bill
 * with money still due can only be closed by paying it.
 */
export async function closeTableBill(ctx: TenantContext, sessionId: string, expectedVersion: number): Promise<TableBillView> {
  await withTx(ctx, async (tx) => {
    const session = await lockSession(tx, ctx, sessionId);
    if (!session) throw new NotFoundError("Table bill not found");
    if (session.status !== TableSessionStatus.OPEN) throw new ConflictError(`The bill ${session.billNumber} is already closed.`, "TABLE_BILL_CLOSED");
    if (session.version !== expectedVersion) throw new ConflictError("The bill changed. Review it and try again.", "BILL_CHANGED", { sessionVersion: session.version });
    const totals = billTotals(await lockSessionOrders(tx, ctx, session.id));
    if (totals.balance.gt(0)) {
      throw new ConflictError(`This bill still owes ${moneyDto(totals.balance)}. Record the payment to close it.`, "BALANCE_DUE");
    }
    if (!(await bumpSession(tx, ctx, session, { at: now() }))) throw new ConflictError("The bill changed. Review it and try again.", "BILL_CHANGED");
    await audit(tx, ctx, {
      action: "table_session.closed",
      resourceType: "table_session",
      resourceId: session.id,
      before: { status: TableSessionStatus.OPEN },
      after: { status: TableSessionStatus.CLOSED, billNumber: session.billNumber, trigger: "closed_by_staff" },
    });
  });
  logger.info("table_session.closed", { requestId: ctx.requestId, tenantId: ctx.tenantId, tableSessionId: sessionId });
  return getTableBill(ctx, sessionId);
}
