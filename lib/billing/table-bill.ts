import { OrderStatus, Prisma } from "@prisma/client";

/**
 * Table bill arithmetic (RASOIOS-ADR-027). Pure and Decimal-only (ADR-010 §1): nothing here prices anything. A table
 * bill is the sum of its orders' own stored snapshots — subtotal, tax, discount and total were fixed when each order
 * was placed (`lib/pricing`), and each line keeps the unit price it was sold at — so a later menu price change never
 * moves an existing bill, and the sum always reconciles to the per-order ledger.
 *
 * Billed orders: every order of the session except CANCELLED (nothing to pay, BR-ORD-05) and REFUNDED (already paid
 * and refunded in full; billing it again would charge twice). They are still listed, as not billed.
 */
const ZERO = new Prisma.Decimal(0);

export type BillOrderInput = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: Date;
  subtotalAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
  items: Array<{
    id: string;
    name: string;
    kotRound: number;
    quantity: number;
    unitPrice: Prisma.Decimal;
    addonsTotal: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    lineSubtotal: Prisma.Decimal;
    lineTax: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
  }>;
};

export type BillLine = {
  /** Display label (item and variant, as sold). */
  name: string;
  quantity: number;
  /** Price of one, add-ons included, as sold. */
  unitPrice: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  lineTax: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Where these came from: each order line keeps its own order and KOT round. */
  sources: Array<{ orderId: string; orderNumber: string; orderItemId: string; kotRound: number; quantity: number }>;
};

export type BillTotals = {
  subtotal: Prisma.Decimal;
  tax: Prisma.Decimal;
  discount: Prisma.Decimal;
  total: Prisma.Decimal;
  paid: Prisma.Decimal;
  refunded: Prisma.Decimal;
  /** total − paid + refunded over the billed orders: what may still be collected. */
  balance: Prisma.Decimal;
};

export const isBilled = (status: OrderStatus) => status !== OrderStatus.CANCELLED && status !== OrderStatus.REFUNDED;

export const outstandingOf = (order: Pick<BillOrderInput, "totalAmount" | "paidAmount" | "refundedAmount">) =>
  order.totalAmount.minus(order.paidAmount).plus(order.refundedAmount);

/** Σ of the billed orders' snapshots. Each order is counted once however many times it appears in `orders`. */
export function billTotals(orders: readonly BillOrderInput[]): BillTotals {
  const billed = uniqueById(orders).filter((o) => isBilled(o.status));
  const sum = (pick: (o: BillOrderInput) => Prisma.Decimal) => billed.reduce((acc, o) => acc.plus(pick(o)), ZERO);
  const totals = {
    subtotal: sum((o) => o.subtotalAmount),
    tax: sum((o) => o.taxAmount),
    discount: sum((o) => o.discountAmount),
    total: sum((o) => o.totalAmount),
    paid: sum((o) => o.paidAmount),
    refunded: sum((o) => o.refundedAmount),
  };
  return { ...totals, balance: totals.total.minus(totals.paid).plus(totals.refunded) };
}

/**
 * The billed orders' lines for presentation: identical items sold at the identical unit price and tax rate are shown
 * as one line with their quantities and amounts added, keeping every source line's order and KOT round. Amounts are
 * the lines' own snapshots added together, so the presentation total equals the bill's subtotal + tax.
 */
export function groupBillLines(orders: readonly BillOrderInput[]): BillLine[] {
  const groups = new Map<string, BillLine>();
  for (const order of uniqueById(orders).filter((o) => isBilled(o.status)).sort(byPlacement)) {
    for (const item of order.items) {
      const unitPrice = item.unitPrice.plus(item.addonsTotal);
      const key = `${item.name}\u0000${unitPrice.toFixed(2)}\u0000${item.taxRate.toFixed(2)}`;
      const group = groups.get(key) ?? {
        name: item.name,
        quantity: 0,
        unitPrice,
        taxRate: item.taxRate,
        lineSubtotal: ZERO,
        lineTax: ZERO,
        lineTotal: ZERO,
        sources: [],
      };
      group.quantity += item.quantity;
      group.lineSubtotal = group.lineSubtotal.plus(item.lineSubtotal);
      group.lineTax = group.lineTax.plus(item.lineTax);
      group.lineTotal = group.lineTotal.plus(item.lineTotal);
      group.sources.push({ orderId: order.id, orderNumber: order.orderNumber, orderItemId: item.id, kotRound: item.kotRound, quantity: item.quantity });
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

export type Allocation = { orderId: string; amount: Prisma.Decimal };

/**
 * Splits a payment across the billed orders that still owe money, oldest order first, each up to what it owes. The
 * parts add up to exactly `amount`. `amount` must not exceed the bill's balance (the caller enforces the ledger rules).
 */
export function allocatePayment(orders: readonly BillOrderInput[], amount: Prisma.Decimal): Allocation[] {
  let remaining = amount;
  const parts: Allocation[] = [];
  for (const order of uniqueById(orders).filter((o) => isBilled(o.status)).sort(byPlacement)) {
    if (remaining.lte(0)) break;
    const owed = outstandingOf(order);
    if (owed.lte(0)) continue;
    const part = Prisma.Decimal.min(owed, remaining);
    parts.push({ orderId: order.id, amount: part });
    remaining = remaining.minus(part);
  }
  if (remaining.gt(0)) throw new RangeError("allocatePayment: amount exceeds what the billed orders owe");
  return parts;
}

function byPlacement(a: BillOrderInput, b: BillOrderInput): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.orderNumber.localeCompare(b.orderNumber);
}

function uniqueById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** "table 1", " TABLE  1 " → "TABLE 1": one table however staff typed it. */
export function tableKeyOf(label: string): string {
  return label.trim().replace(/\s+/g, " ").toUpperCase();
}
