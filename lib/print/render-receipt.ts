import type { OrderType, PaymentMethod, TransactionType } from "@prisma/client";
import { toMoneyString } from "@/lib/money";
import { gstBreakup } from "@/lib/pricing/gst";
import { printableMoney, printableTimestamp, quantityLabel } from "./format";
import { fitRow, sanitizeLine, wrapText } from "./text";
import { assertPrintable, columnsFor, paperWidthOf, type PaperWidthMm, type PrintBlock, type PrintDocument } from "./types";

/**
 * Receipt document (S1-P16-T002, architecture.md §6.4, REQ-TXN-011, Q-004 C).
 *
 * Amounts are the order's stored snapshots as two-decimal strings — they are never recomputed here and never pass
 * through a float (ADR-010 §1). When the restaurant has a GSTIN the receipt prints it and a CGST/SGST table with one
 * row per distinct tax rate (`lib/pricing/gst.ts`); without a GSTIN it prints one "Tax" line. The totals are identical
 * either way, because both are presentations of the same snapshots (TC-PRINT-017).
 *
 * The receipt prints the customer's *name* when the order has one; it never prints a phone number or an email address
 * (SC-PRINT-07, TC-PRINT-009).
 */
export type ReceiptDocumentItem = {
  quantity: number;
  label: string;
  taxRate: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
};

export type ReceiptDocumentLedgerEntry = {
  type: TransactionType;
  method: PaymentMethod;
  amount: string;
  amountTendered: string | null;
  changeDue: string | null;
};

export type ReceiptDocumentInput = {
  widthMm: number;
  restaurantName: string;
  addressLines: readonly string[];
  phone: string | null;
  gstin: string | null;
  orderNumber: string;
  orderType: OrderType;
  tableLabel: string | null;
  createdAt: Date;
  timeZone: string;
  currencyCode: string;
  customerName: string | null;
  items: readonly ReceiptDocumentItem[];
  totals: { subtotal: string; tax: string; discount: string; total: string; paid: string; refunded: string; balance: string };
  ledger: readonly ReceiptDocumentLedgerEntry[];
  footer: string | null;
  isReprint?: boolean;
  copyLabel?: string | null;
  copyIndex?: number;
  copyCount?: number;
};

/**
 * Returns the standard label for a copy when multiple copies are printed:
 * - 1 copy: null (standard receipt)
 * - 2 copies: "CUSTOMER COPY" (copy 1), "RESTAURANT COPY" (copy 2)
 * - 3+ copies: "CUSTOMER COPY", "RESTAURANT COPY", "COPY 3", etc.
 */
export function receiptCopyLabel(copyIndex: number, totalCopies: number): string | null {
  if (totalCopies <= 1) return null;
  if (totalCopies === 2) {
    return copyIndex === 1 ? "CUSTOMER COPY" : "RESTAURANT COPY";
  }
  if (copyIndex === 1) return "CUSTOMER COPY";
  if (copyIndex === 2) return "RESTAURANT COPY";
  return `COPY ${copyIndex}`;
}

const ORDER_TYPE_LABELS: Readonly<Record<OrderType, string>> = { DINE_IN: "Dine-in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery" };
const METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = { CASH: "Cash", CARD: "Card", UPI: "UPI" };

const isZero = (amount: string) => /^0(\.0+)?$/.test(amount.trim());

export function renderReceiptDocument(input: ReceiptDocumentInput): PrintDocument {
  const widthMm: PaperWidthMm = paperWidthOf(input.widthMm);
  const columns = columnsFor(widthMm);
  const money = (amount: string) => printableMoney(amount, input.currencyCode);
  const line = (text: string, extra: Omit<Extract<PrintBlock, { type: "text" }>, "type" | "text"> = {}): PrintBlock[] =>
    wrapText(text, columns).map((part) => ({ type: "text" as const, text: part, ...extra }));
  const row = (left: string, right: string, bold = false): PrintBlock => ({ type: "row", ...fitRow(left, right, columns), ...(bold ? { bold: true } : {}) });

  const blocks: PrintBlock[] = [...line(sanitizeLine(input.restaurantName, 60), { align: "center", bold: true })];
  for (const address of input.addressLines) blocks.push(...line(sanitizeLine(address, 160), { align: "center" }));
  if (input.phone) blocks.push({ type: "text", text: `Tel ${sanitizeLine(input.phone, 20)}`, align: "center" });
  if (input.gstin) blocks.push({ type: "text", text: `GSTIN ${sanitizeLine(input.gstin, 15)}`, align: "center" });

  blocks.push({ type: "divider", style: "solid" });
  if (input.copyLabel) blocks.push({ type: "text", text: `*** ${input.copyLabel} ***`, align: "center", bold: true });
  if (input.isReprint) blocks.push({ type: "text", text: "*** REPRINT ***", align: "center", bold: true });
  blocks.push(row("Receipt", sanitizeLine(input.orderNumber, 24)));
  blocks.push(row("Date", printableTimestamp(input.createdAt, input.timeZone)));
  blocks.push(row("Type", ORDER_TYPE_LABELS[input.orderType]));
  if (input.tableLabel) blocks.push(row("Table", sanitizeLine(input.tableLabel, 20)));
  if (input.customerName) blocks.push(row("Customer", sanitizeLine(input.customerName, 40)));
  blocks.push({ type: "divider", style: "dashed" });

  for (const item of input.items) {
    blocks.push(...line(quantityLabel(item.quantity, sanitizeLine(item.label, 120))));
    blocks.push(row("", money(item.lineTotal)));
  }

  blocks.push({ type: "divider", style: "dashed" });
  blocks.push(row("Subtotal", money(input.totals.subtotal)));
  if (!isZero(input.totals.discount)) blocks.push(row("Discount", `- ${money(input.totals.discount)}`));

  if (input.gstin) {
    for (const group of gstBreakup(input.items.map((item) => ({ taxRate: item.taxRate, lineSubtotal: item.lineSubtotal, lineTax: item.lineTax })))) {
      const half = toMoneyString(group.cgstRate);
      blocks.push(row(`CGST ${half}% on ${toMoneyString(group.taxableValue)}`, money(toMoneyString(group.cgstAmount))));
      blocks.push(row(`SGST ${half}% on ${toMoneyString(group.taxableValue)}`, money(toMoneyString(group.sgstAmount))));
    }
  } else {
    blocks.push(row("Tax", money(input.totals.tax)));
  }

  blocks.push(row("TOTAL", money(input.totals.total), true));
  blocks.push({ type: "divider", style: "dashed" });

  for (const entry of input.ledger) {
    const label = entry.type === "REFUND" ? `Refund (${METHOD_LABELS[entry.method]})` : METHOD_LABELS[entry.method];
    blocks.push(row(label, money(entry.amount)));
    if (entry.amountTendered) blocks.push(row("Tendered", money(entry.amountTendered)));
    if (entry.changeDue && !isZero(entry.changeDue)) blocks.push(row("Change", money(entry.changeDue)));
  }
  if (!isZero(input.totals.balance)) blocks.push(row("Balance due", money(input.totals.balance), true));

  const footer = sanitizeLine(input.footer, 280);
  if (footer) {
    blocks.push({ type: "divider", style: "solid" });
    blocks.push(...line(footer, { align: "center" }));
  }

  blocks.push({ type: "spacer", lines: 2 });
  blocks.push({ type: "cut" });

  return assertPrintable({
    version: 1,
    widthMm,
    blocks,
    copyIndex: input.copyIndex,
    copyCount: input.copyCount,
    copyLabel: input.copyLabel ?? undefined,
  });
}
