import "server-only";
import { Prisma, TableSessionStatus, TransactionStatus, type OrderStatus, type PaymentMethod, type PaymentStatus, type KotStatus } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import type { BillOrderInput } from "@/lib/billing/table-bill";
import { db } from "@/lib/db/prisma";
import { mapErrors } from "./errors";
import { tenantKey, tenantScope } from "./scope";
import type { Tx } from "./tx";

/**
 * Table bills data access (RASOIOS-ADR-027). Every statement is scoped to `ctx.tenantId`; a session id from another
 * tenant reads exactly like an unknown one. The locking functions take the caller's transaction:
 *
 * - joining an order and taking a table payment both lock the session row (`FOR UPDATE`), so they run one after the
 *   other and a payment always sees every order that joined before it;
 * - `version` moves on every join, payment and close, so a payment built from an older view of the bill is refused.
 */

export type SessionRow = {
  id: string;
  tableLabel: string;
  tableKey: string;
  billNumber: string;
  status: TableSessionStatus;
  version: number;
  businessDate: Date;
  openedAt: Date;
  closedAt: Date | null;
};

const sessionSelect = {
  id: true,
  tableLabel: true,
  tableKey: true,
  billNumber: true,
  status: true,
  version: true,
  businessDate: true,
  openedAt: true,
  closedAt: true,
} satisfies Prisma.TableSessionSelect;

/** The OPEN session of a table, locked until the caller's transaction ends; null when the table has none. */
export async function lockOpenSessionOfTable(tx: Tx, ctx: TenantContext, tableKey: string): Promise<SessionRow | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM table_sessions
    WHERE tenant_id = ${ctx.tenantId}::uuid AND table_key = ${tableKey} AND status = 'OPEN'::table_session_status
    FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.tableSession.findUnique({ where: tenantKey(ctx, locked[0].id), select: sessionSelect });
}

/** A session of the caller's tenant, locked until the caller's transaction ends. */
export async function lockSession(tx: Tx, ctx: TenantContext, sessionId: string): Promise<SessionRow | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM table_sessions WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${sessionId}::uuid FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.tableSession.findUnique({ where: tenantKey(ctx, sessionId), select: sessionSelect });
}

/** The OPEN session of a table, without locking (for showing it in order entry). */
export async function findOpenSessionOfTable(ctx: TenantContext, tableKey: string): Promise<SessionRow | null> {
  return mapErrors("Table bill", () =>
    db.tableSession.findFirst({ where: tenantScope(ctx, { tableKey, status: TableSessionStatus.OPEN }), select: sessionSelect }),
  );
}

export async function insertSession(
  tx: Tx,
  ctx: TenantContext,
  session: { tableLabel: string; tableKey: string; billNumber: string; businessDate: Date },
): Promise<SessionRow> {
  return tx.tableSession.create({
    data: { ...session, tenantId: ctx.tenantId, openedByUserId: ctx.userId, status: TableSessionStatus.OPEN },
    select: sessionSelect,
  });
}

/** Puts an order on a session's bill and moves the bill's version, so an open payment dialog must reload. */
export async function joinSession(tx: Tx, ctx: TenantContext, session: Pick<SessionRow, "id" | "version">, orderId: string): Promise<number> {
  await tx.order.update({ where: tenantKey(ctx, orderId), data: { tableSessionId: session.id } });
  const { count } = await tx.tableSession.updateMany({
    where: { tenantId: ctx.tenantId, id: session.id, version: session.version, status: TableSessionStatus.OPEN },
    data: { version: { increment: 1 } },
  });
  // The row is locked by the caller, so this cannot miss; if it ever does, the whole order rolls back.
  if (count !== 1) throw new Error("table session changed under its row lock");
  return session.version + 1;
}

/** Moves the version (a payment changed the bill) and closes the session when `close` is set. Compare-and-set. */
export async function bumpSession(
  tx: Tx,
  ctx: TenantContext,
  session: Pick<SessionRow, "id" | "version">,
  close: { at: Date } | null,
): Promise<boolean> {
  const { count } = await tx.tableSession.updateMany({
    where: { tenantId: ctx.tenantId, id: session.id, version: session.version, status: TableSessionStatus.OPEN },
    data: {
      version: { increment: 1 },
      ...(close ? { status: TableSessionStatus.CLOSED, closedAt: close.at, closedByUserId: ctx.userId } : {}),
    },
  });
  return count === 1;
}

// ─── The bill's orders ───

const billOrderSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  createdAt: true,
  subtotalAmount: true,
  taxAmount: true,
  discountAmount: true,
  totalAmount: true,
  paidAmount: true,
  refundedAmount: true,
  version: true,
  customer: { select: { id: true, fullName: true, phoneE164: true } },
  items: {
    orderBy: [{ kotRound: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      itemNameSnapshot: true,
      variantNameSnapshot: true,
      kotRound: true,
      quantity: true,
      unitPriceSnapshot: true,
      addonsTotalSnapshot: true,
      taxRateSnapshot: true,
      lineSubtotal: true,
      lineTax: true,
      lineTotal: true,
    },
  },
  kotTickets: { orderBy: [{ roundNumber: "asc" }, { kotNumber: "asc" }], select: { id: true, kotNumber: true, status: true, roundNumber: true } },
} satisfies Prisma.OrderSelect;

type BillOrderRow = Prisma.OrderGetPayload<{ select: typeof billOrderSelect }>;

export type SessionOrder = BillOrderInput & {
  paymentStatus: PaymentStatus;
  version: number;
  customer: { id: string; name: string; phone: string | null } | null;
  kots: Array<{ id: string; kotNumber: string; status: KotStatus; round: number }>;
};

function toSessionOrder(row: BillOrderRow): SessionOrder {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentStatus: row.paymentStatus,
    createdAt: row.createdAt,
    subtotalAmount: row.subtotalAmount,
    taxAmount: row.taxAmount,
    discountAmount: row.discountAmount,
    totalAmount: row.totalAmount,
    paidAmount: row.paidAmount,
    refundedAmount: row.refundedAmount,
    version: row.version,
    customer: row.customer ? { id: row.customer.id, name: row.customer.fullName, phone: row.customer.phoneE164 } : null,
    kots: row.kotTickets.map((k) => ({ id: k.id, kotNumber: k.kotNumber, status: k.status, round: k.roundNumber })),
    items: row.items.map((i) => ({
      id: i.id,
      name: i.variantNameSnapshot ? `${i.itemNameSnapshot} (${i.variantNameSnapshot})` : i.itemNameSnapshot,
      kotRound: i.kotRound,
      quantity: i.quantity,
      unitPrice: i.unitPriceSnapshot,
      addonsTotal: i.addonsTotalSnapshot,
      taxRate: i.taxRateSnapshot,
      lineSubtotal: i.lineSubtotal,
      lineTax: i.lineTax,
      lineTotal: i.lineTotal,
    })),
  };
}

/** The session's orders (oldest first), read in the caller's transaction. */
export async function sessionOrders(client: Tx, ctx: TenantContext, sessionId: string): Promise<SessionOrder[]> {
  const rows = await client.order.findMany({
    where: tenantScope(ctx, { tableSessionId: sessionId }),
    orderBy: [{ createdAt: "asc" }, { orderNumber: "asc" }],
    select: billOrderSelect,
  });
  return rows.map(toSessionOrder);
}

/**
 * Locks every order of the session (in id order, so two lockers never deadlock), then reads them. Called after
 * `lockSession`, so no order can join or leave while a payment is being applied.
 */
export async function lockSessionOrders(tx: Tx, ctx: TenantContext, sessionId: string): Promise<SessionOrder[]> {
  await tx.$queryRaw`
    SELECT id FROM orders WHERE tenant_id = ${ctx.tenantId}::uuid AND table_session_id = ${sessionId}::uuid ORDER BY id FOR UPDATE`;
  return sessionOrders(tx, ctx, sessionId);
}

// ─── Reads for the console ───

export type SessionPaymentRow = {
  id: string;
  method: PaymentMethod;
  amount: Prisma.Decimal;
  amountTendered: Prisma.Decimal | null;
  changeDue: Prisma.Decimal | null;
  reference: string | null;
  createdAt: Date;
  /** False when every ledger row of this payment was voided. */
  active: boolean;
};

const paymentSelect = {
  id: true,
  paymentMethod: true,
  amount: true,
  amountTendered: true,
  changeDue: true,
  reference: true,
  createdAt: true,
  transactions: { select: { status: true } },
} satisfies Prisma.TableSessionPaymentSelect;

function toPaymentRow(row: Prisma.TableSessionPaymentGetPayload<{ select: typeof paymentSelect }>): SessionPaymentRow {
  return {
    id: row.id,
    method: row.paymentMethod,
    amount: row.amount,
    amountTendered: row.amountTendered,
    changeDue: row.changeDue,
    reference: row.reference,
    createdAt: row.createdAt,
    active: row.transactions.length === 0 || row.transactions.some((t) => t.status === TransactionStatus.SUCCESS),
  };
}

export async function findSession(client: Tx, ctx: TenantContext, sessionId: string): Promise<SessionRow | null> {
  return client.tableSession.findUnique({ where: tenantKey(ctx, sessionId), select: sessionSelect });
}

export async function sessionPayments(client: Tx, ctx: TenantContext, sessionId: string): Promise<SessionPaymentRow[]> {
  const rows = await client.tableSessionPayment.findMany({
    where: tenantScope(ctx, { tableSessionId: sessionId }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: paymentSelect,
  });
  return rows.map(toPaymentRow);
}

/** Open bills, oldest first, with what each owes — for the Orders board's "Open tables" strip. */
export async function listOpenSessions(ctx: TenantContext): Promise<Array<SessionRow & { orderCount: number; orders: SessionOrder[] }>> {
  const rows = await mapErrors("Table bill", () =>
    db.tableSession.findMany({
      where: tenantScope(ctx, { status: TableSessionStatus.OPEN }),
      orderBy: { openedAt: "asc" },
      take: 100,
      select: { ...sessionSelect, orders: { where: { tenantId: ctx.tenantId }, select: billOrderSelect, orderBy: { createdAt: "asc" } } },
    }),
  );
  return rows.map(({ orders, ...session }) => ({ ...session, orderCount: orders.length, orders: orders.map(toSessionOrder) }));
}

// ─── Table payments ───

export type NewSessionPayment = {
  tableSessionId: string;
  idempotencyKey: string;
  paymentMethod: PaymentMethod;
  amount: Prisma.Decimal;
  amountTendered: Prisma.Decimal | null;
  changeDue: Prisma.Decimal | null;
  reference: string | null;
  businessDate: Date;
};

export async function insertSessionPayment(tx: Tx, ctx: TenantContext, payment: NewSessionPayment): Promise<{ id: string }> {
  return tx.tableSessionPayment.create({ data: { ...payment, tenantId: ctx.tenantId, recordedByUserId: ctx.userId }, select: { id: true } });
}

export async function findSessionPaymentByKey(
  client: Tx,
  ctx: TenantContext,
  idempotencyKey: string,
): Promise<{ id: string; tableSessionId: string; paymentMethod: PaymentMethod; amount: Prisma.Decimal; amountTendered: Prisma.Decimal | null; changeDue: Prisma.Decimal | null } | null> {
  return client.tableSessionPayment.findFirst({
    where: { tenantId: ctx.tenantId, idempotencyKey },
    select: { id: true, tableSessionId: true, paymentMethod: true, amount: true, amountTendered: true, changeDue: true },
  });
}

/** The per-order ledger rows one table payment was split into. */
export async function sessionPaymentLedgerRows(client: Tx, ctx: TenantContext, paymentId: string): Promise<Array<{ id: string; orderId: string; amount: Prisma.Decimal }>> {
  return client.transaction.findMany({
    where: tenantScope(ctx, { tableSessionPaymentId: paymentId }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderId: true, amount: true },
  });
}

export async function findSessionPayment(client: Tx, ctx: TenantContext, paymentId: string): Promise<{ id: string; tableSessionId: string } | null> {
  return client.tableSessionPayment.findUnique({ where: tenantKey(ctx, paymentId), select: { id: true, tableSessionId: true } });
}

export type { OrderStatus };
