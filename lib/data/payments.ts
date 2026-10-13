import "server-only";
import { OrderStatus, PaymentStatus, Prisma, TransactionStatus, TransactionType } from "@prisma/client";
import type { PaymentMethod } from "@prisma/client";
import type { TenantContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { instantDto, moneyDto, type MoneyString } from "./dto";
import { mapErrors } from "./errors";
import { tenantKey } from "./scope";
import type { Tx } from "./tx";

/**
 * Ledger data access (S1-P04-T007; ADR-008, ADR-010 §7–8, data-model E14/E19). Every query is scoped to
 * `ctx.tenantId`; the transactional functions take the caller's transaction client so the ledger row, the order totals
 * and the audit row commit together (`lib/services/payments.ts`).
 */

const ledgerOrderSelect = {
  id: true,
  status: true,
  paymentStatus: true,
  totalAmount: true,
  paidAmount: true,
  refundedAmount: true,
  version: true,
  tableSession: { select: { id: true, status: true, billNumber: true, tableLabel: true } },
} satisfies Prisma.OrderSelect;

export type LedgerOrder = Prisma.OrderGetPayload<{ select: typeof ledgerOrderSelect }>;

const ledgerRowSelect = {
  id: true,
  orderId: true,
  type: true,
  paymentMethod: true,
  status: true,
  amount: true,
  amountTendered: true,
  changeDue: true,
  businessDate: true,
  refundOfTransactionId: true,
} satisfies Prisma.TransactionSelect;

export type LedgerRow = Prisma.TransactionGetPayload<{ select: typeof ledgerRowSelect }>;

/**
 * Locks the order row until the transaction ends (`SELECT … FOR UPDATE`), then reads it. Concurrent payments and
 * refunds on one order therefore run one after another and each sees the previous one's totals (TC-TXN-005).
 * Returns null for a missing order and for another tenant's order alike.
 */
export async function lockOrderForLedger(ctx: TenantContext, tx: Tx, orderId: string): Promise<LedgerOrder | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM orders WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.order.findUnique({ where: tenantKey(ctx, orderId), select: ledgerOrderSelect });
}

/** Reads the order's ledger fields without locking (null when missing or another tenant's). */
export async function readLedgerOrder(ctx: TenantContext, tx: Tx, orderId: string): Promise<LedgerOrder | null> {
  return tx.order.findUnique({ where: tenantKey(ctx, orderId), select: ledgerOrderSelect });
}

/** The ledger row recorded with this idempotency key in the caller's tenant, if any (UNIQUE (tenant_id, idempotency_key)). */
export async function findLedgerRowByIdempotencyKey(ctx: TenantContext, tx: Tx, idempotencyKey: string): Promise<LedgerRow | null> {
  return tx.transaction.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey }, select: ledgerRowSelect });
}

/** A ledger row of the caller's tenant by id (null when missing or another tenant's). */
export async function findLedgerRow(ctx: TenantContext, tx: Tx, transactionId: string): Promise<LedgerRow | null> {
  return tx.transaction.findUnique({ where: tenantKey(ctx, transactionId), select: ledgerRowSelect });
}

/** Σ successful REFUND amounts already recorded against one payment. */
export async function sumRefundsOfPayment(ctx: TenantContext, tx: Tx, paymentTransactionId: string): Promise<Prisma.Decimal> {
  const result = await tx.transaction.aggregate({
    where: { tenantId: ctx.tenantId, refundOfTransactionId: paymentTransactionId, type: TransactionType.REFUND, status: TransactionStatus.SUCCESS },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}

export type OrderLedgerUpdate = {
  paidAmount?: Prisma.Decimal;
  refundedAmount?: Prisma.Decimal;
  paymentStatus: PaymentStatus;
  status?: OrderStatus;
  completedAt?: Date;
  refundedAt?: Date;
};

/**
 * Writes recomputed ledger totals to the order, guarded by the version read under the row lock. Returns false when
 * the order changed in between (the caller turns that into a 409).
 */
export async function updateOrderLedgerTotals(ctx: TenantContext, tx: Tx, order: Pick<LedgerOrder, "id" | "version">, data: OrderLedgerUpdate): Promise<boolean> {
  const { count } = await tx.order.updateMany({
    where: { id: order.id, tenantId: ctx.tenantId, version: order.version },
    data: { ...data, version: { increment: 1 } },
  });
  return count === 1;
}

export type NewLedgerRow = {
  orderId: string;
  type: TransactionType;
  paymentMethod: PaymentMethod;
  amount: Prisma.Decimal;
  amountTendered?: Prisma.Decimal | null;
  changeDue?: Prisma.Decimal | null;
  reference?: string | null;
  refundOfTransactionId?: string | null;
  reason?: string | null;
  businessDate: Date;
  idempotencyKey: string;
  /** Set when this row is one order's share of a table-bill payment (RASOIOS-ADR-027). */
  tableSessionPaymentId?: string | null;
};

/** Appends a SUCCESS ledger row for the caller's tenant, recorded by the caller. */
export async function insertLedgerRow(ctx: TenantContext, tx: Tx, row: NewLedgerRow): Promise<LedgerRow> {
  return tx.transaction.create({
    data: {
      ...row,
      tenantId: ctx.tenantId,
      status: TransactionStatus.SUCCESS,
      recordedByUserId: ctx.userId,
    },
    select: ledgerRowSelect,
  });
}

// ─── Billing terminal work queue ───

export type BillableOrderDto = {
  id: string;
  orderNumber: string;
  orderType: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  tableLabel: string | null;
  customerName: string | null;
  currencyCode: string;
  total: MoneyString;
  paid: MoneyString;
  refunded: MoneyString;
  /** total − paid + refunded: what the terminal may still collect (ADR-010 §8). */
  balance: MoneyString;
  createdAt: string;
  items: Array<{ id: string; name: string; quantity: number; lineTotal: MoneyString }>;
};

/** Orders awaiting settlement: not cancelled or refunded, and unpaid or partially paid. Newest first. */
export async function listBillableOrders(ctx: TenantContext, limit = 100): Promise<BillableOrderDto[]> {
  const rows = await mapErrors("Order", () =>
    db.order.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] },
        paymentStatus: { in: [PaymentStatus.UNPAID, PaymentStatus.PARTIALLY_PAID] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        orderNumber: true,
        orderType: true,
        status: true,
        paymentStatus: true,
        tableLabel: true,
        totalAmount: true,
        paidAmount: true,
        refundedAmount: true,
        currencyCode: true,
        createdAt: true,
        customer: { select: { fullName: true } },
        items: { orderBy: { createdAt: "asc" }, select: { id: true, itemNameSnapshot: true, variantNameSnapshot: true, quantity: true, lineTotal: true } },
      },
    }),
  );
  return rows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    orderType: o.orderType,
    status: o.status,
    paymentStatus: o.paymentStatus,
    tableLabel: o.tableLabel,
    customerName: o.customer?.fullName ?? null,
    currencyCode: o.currencyCode,
    total: moneyDto(o.totalAmount),
    paid: moneyDto(o.paidAmount),
    refunded: moneyDto(o.refundedAmount),
    balance: moneyDto(o.totalAmount.minus(o.paidAmount).plus(o.refundedAmount)),
    createdAt: instantDto(o.createdAt),
    items: o.items.map((i) => ({
      id: i.id,
      name: i.variantNameSnapshot ? `${i.itemNameSnapshot} (${i.variantNameSnapshot})` : i.itemNameSnapshot,
      quantity: i.quantity,
      lineTotal: moneyDto(i.lineTotal),
    })),
  }));
}
