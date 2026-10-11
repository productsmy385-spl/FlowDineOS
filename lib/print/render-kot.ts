import type { OrderPriority, OrderType } from "@prisma/client";
import { printableTimestamp, quantityLabel } from "./format";
import { fitRow, sanitizeLine, wrapText } from "./text";
import { assertPrintable, columnsFor, paperWidthOf, type PaperWidthMm, type PrintBlock, type PrintDocument } from "./types";

/**
 * KOT document (S1-P16-T002, architecture.md §6.4, REQ-KOT-003).
 *
 * The kitchen ticket carries the ticket number, its section and round, the order it belongs to, where it is going and
 * the lines to cook. It carries **no money and no customer contact details** — the same projection the kitchen board
 * uses (SC-RBAC-07, SC-PRINT-07, TC-PRINT-009). Every string is sanitised and wrapped to the roll's column count
 * before it is stored, so the agent never has to make layout decisions.
 */
export type KotDocumentItem = {
  quantity: number;
  /** Item name (with variant) as snapshotted on the ticket. */
  label: string;
  addons: string | null;
  instructions: string | null;
};

export type KotDocumentInput = {
  widthMm: number;
  restaurantName: string;
  kotNumber: string;
  sectionName: string | null;
  roundNumber: number;
  orderNumber: string;
  orderType: OrderType;
  tableLabel: string | null;
  priority: OrderPriority;
  queuedAt: Date;
  timeZone: string;
  notes: string | null;
  items: readonly KotDocumentItem[];
  isReprint?: boolean;
  copyLabel?: string | null;
  copyIndex?: number;
  copyCount?: number;
};

/**
 * Returns the label for a KOT copy when multiple copies are printed:
 * - 1 copy: null (standard ticket)
 * - 2+ copies: "COPY 1 OF 2", "COPY 2 OF 2", etc.
 */
export function kotCopyLabel(copyIndex: number, totalCopies: number): string | null {
  if (totalCopies <= 1) return null;
  return `COPY ${copyIndex} OF ${totalCopies}`;
}

const ORDER_TYPE_LABELS: Readonly<Record<OrderType, string>> = {
  DINE_IN: "Dine-in",
  TAKEAWAY: "Takeaway",
  DELIVERY: "Delivery",
};

export function renderKotDocument(input: KotDocumentInput): PrintDocument {
  const widthMm: PaperWidthMm = paperWidthOf(input.widthMm);
  const columns = columnsFor(widthMm);
  const line = (text: string, extra: Omit<Extract<PrintBlock, { type: "text" }>, "type" | "text"> = {}): PrintBlock[] =>
    wrapText(text, columns).map((part) => ({ type: "text" as const, text: part, ...extra }));
  const row = (left: string, right: string): PrintBlock => ({ type: "row", ...fitRow(left, right, columns) });

  const blocks: PrintBlock[] = [
    ...line(sanitizeLine(input.restaurantName, 60), { align: "center", bold: true }),
    { type: "divider", style: "solid" },
    { type: "text", text: sanitizeLine(input.kotNumber, 16), align: "center", bold: true, size: "double" },
  ];

  if (input.copyLabel) blocks.push({ type: "text", text: `*** ${input.copyLabel} ***`, align: "center", bold: true });
  if (input.isReprint) blocks.push({ type: "text", text: "*** REPRINT ***", align: "center", bold: true });
  if (input.priority === "HIGH") blocks.push({ type: "text", text: "*** RUSH ***", align: "center", bold: true });

  blocks.push({ type: "divider", style: "dashed" });
  blocks.push(row("Order", sanitizeLine(input.orderNumber, 24)));
  blocks.push(row("Type", ORDER_TYPE_LABELS[input.orderType]));
  if (input.tableLabel) blocks.push(row("Table", sanitizeLine(input.tableLabel, 20)));
  blocks.push(row("Station", sanitizeLine(input.sectionName, 24) || "All"));
  blocks.push(row("Round", String(input.roundNumber)));
  blocks.push(row("Time", printableTimestamp(input.queuedAt, input.timeZone)));
  blocks.push({ type: "divider", style: "dashed" });

  for (const item of input.items) {
    blocks.push(...line(quantityLabel(item.quantity, sanitizeLine(item.label, 120)), { bold: true }));
    const addons = sanitizeLine(item.addons, 200);
    if (addons) blocks.push(...line(`+ ${addons}`));
    const instructions = sanitizeLine(item.instructions, 200);
    if (instructions) blocks.push(...line(`! ${instructions}`, { bold: true }));
  }

  const notes = sanitizeLine(input.notes, 280);
  if (notes) {
    blocks.push({ type: "divider", style: "dashed" });
    blocks.push(...line(`Note: ${notes}`));
  }

  blocks.push({ type: "divider", style: "solid" });
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
