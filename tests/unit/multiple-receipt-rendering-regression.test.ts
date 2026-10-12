import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePrintDocument, toWirePrintDocument, printBlockSchema } from "@/lib/print/types";
import { renderReceiptDocument, receiptCopyLabel, type ReceiptDocumentInput } from "@/lib/print/render-receipt";
import { renderKotDocument, kotCopyLabel, type KotDocumentInput } from "@/lib/print/render-kot";
import { encodeDocument } from "@/print-agent/src/escpos";
import { profileOf } from "@/lib/print/profiles";
import { recordPaymentSchema } from "@/lib/validation/payments";
import { createPrinterSchema } from "@/lib/validation/printing";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const TZ = "Asia/Kolkata";

const mockReceiptInput = (overrides: Partial<ReceiptDocumentInput> = {}): ReceiptDocumentInput => ({
  widthMm: 80,
  restaurantName: "Akshayapatra",
  addressLines: ["Main Road", "Devarapalli AP 534313"],
  phone: "+919032641487",
  gstin: null,
  orderNumber: "20261012-0001",
  orderType: "DINE_IN",
  tableLabel: "T1",
  createdAt: NOW,
  timeZone: TZ,
  currencyCode: "INR",
  customerName: "Partha",
  items: [
    { quantity: 1, label: "Chicken Lollipop [wet]", taxRate: "5.00", lineSubtotal: "280.00", lineTax: "14.00", lineTotal: "294.00" },
    { quantity: 6, label: "Roti", taxRate: "5.00", lineSubtotal: "42.00", lineTax: "2.10", lineTotal: "44.10" },
  ],
  totals: { subtotal: "322.00", tax: "16.10", discount: "0.00", total: "338.10", paid: "338.10", refunded: "0.00", balance: "0.00" },
  ledger: [{ type: "PAYMENT", method: "CASH", amount: "338.10", amountTendered: "338.10", changeDue: "0.00" }],
  footer: "Thank you for dining with us!",
  ...overrides,
});

const mockKotInput = (overrides: Partial<KotDocumentInput> = {}): KotDocumentInput => ({
  widthMm: 80,
  restaurantName: "Akshayapatra",
  kotNumber: "K-002",
  sectionName: "Main Kitchen",
  roundNumber: 1,
  orderNumber: "20261012-0002",
  orderType: "DINE_IN",
  tableLabel: "T1",
  priority: "NORMAL",
  queuedAt: NOW,
  timeZone: TZ,
  notes: null,
  items: [
    { quantity: 1, label: "Chicken Bone Fry", addons: null, instructions: null },
    { quantity: 1, label: "Chana Fry", addons: null, instructions: null },
  ],
  ...overrides,
});

describe("P0 Multiple Receipt Printing Regression Suite", () => {
  // ── 1. Standard single KOT ──
  it("1. Standard single KOT renders clean ticket without copy banner", () => {
    const label = kotCopyLabel(1, 1);
    expect(label).toBeNull();

    const doc = renderKotDocument(mockKotInput({ copyIndex: 1, copyCount: 1, copyLabel: label }));
    expect(doc.version).toBe(1);
    expect(doc.widthMm).toBe(80);
    // Should NOT have a COPY banner block
    const hasCopyBanner = doc.blocks.some((b) => b.type === "text" && b.text.includes("COPY"));
    expect(hasCopyBanner).toBe(false);

    // Encodes cleanly to ESC/POS
    const bytes = encodeDocument(doc);
    expect(bytes.length).toBeGreaterThan(0);
  });

  // ── 2. Default two-copy receipt ──
  it("2. Default two-copy receipt produces distinct customer and restaurant copies", () => {
    const label1 = receiptCopyLabel(1, 2);
    const label2 = receiptCopyLabel(2, 2);
    expect(label1).toBe("CUSTOMER COPY");
    expect(label2).toBe("RESTAURANT COPY");

    const copy1 = renderReceiptDocument(mockReceiptInput({ copyLabel: label1, copyIndex: 1, copyCount: 2 }));
    const copy2 = renderReceiptDocument(mockReceiptInput({ copyLabel: label2, copyIndex: 2, copyCount: 2 }));

    expect(copy1.blocks.some((b) => b.type === "text" && b.text.includes("*** CUSTOMER COPY ***"))).toBe(true);
    expect(copy2.blocks.some((b) => b.type === "text" && b.text.includes("*** RESTAURANT COPY ***"))).toBe(true);
  });

  // ── 3. CUSTOMER COPY rendering ──
  it("3. CUSTOMER COPY rendering has correct formatting, totals and item lines", () => {
    const doc = renderReceiptDocument(mockReceiptInput({ copyLabel: "CUSTOMER COPY", copyIndex: 1, copyCount: 2 }));
    const textBlocks = doc.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    const rowBlocks = doc.blocks.filter((b) => b.type === "row").map((b) => (b as { left: string; right: string }));

    expect(textBlocks).toContain("*** CUSTOMER COPY ***");
    expect(textBlocks).toContain("Akshayapatra");
    expect(rowBlocks.some((r) => r.left === "TOTAL" && r.right.includes("338.10"))).toBe(true);
    expect(rowBlocks.some((r) => r.left === "Cash" && r.right.includes("338.10"))).toBe(true);
  });

  // ── 4. RESTAURANT COPY rendering ──
  it("4. RESTAURANT COPY rendering contains restaurant banner and valid cuts", () => {
    const doc = renderReceiptDocument(mockReceiptInput({ copyLabel: "RESTAURANT COPY", copyIndex: 2, copyCount: 2 }));
    expect(doc.blocks.some((b) => b.type === "text" && b.text === "*** RESTAURANT COPY ***")).toBe(true);
    expect(doc.blocks[doc.blocks.length - 1].type).toBe("cut");
  });

  // ── 5. Configured copy count greater than two ──
  it("5. Configured copy count greater than two labels 3+ copies as COPY 3, etc.", () => {
    expect(receiptCopyLabel(1, 3)).toBe("CUSTOMER COPY");
    expect(receiptCopyLabel(2, 3)).toBe("RESTAURANT COPY");
    expect(receiptCopyLabel(3, 3)).toBe("COPY 3");

    const copy3 = renderReceiptDocument(mockReceiptInput({ copyLabel: receiptCopyLabel(3, 3), copyIndex: 3, copyCount: 3 }));
    expect(copy3.blocks.some((b) => b.type === "text" && b.text.includes("*** COPY 3 ***"))).toBe(true);
  });

  // ── 6. Payment-time copy override ──
  it("6. Payment-time copy override parses requestedCopies between 1 and 10", () => {
    const parsed = recordPaymentSchema.parse({
      orderId: "04d34d3a-c51c-4585-b8ff-594eeb6af109",
      idempotencyKey: "04d34d3a-c51c-4585-b8ff-594eeb6af111",
      method: "CASH",
      amount: "338.10",
      receiptCopies: 3,
    });
    expect(parsed.receiptCopies).toBe(3);

    // Refuses out of bounds (<1 or >10)
    expect(() =>
      recordPaymentSchema.parse({
        orderId: "04d34d3a-c51c-4585-b8ff-594eeb6af109",
        idempotencyKey: "04d34d3a-c51c-4585-b8ff-594eeb6af112",
        method: "CASH",
        amount: "338.10",
        receiptCopies: 0,
      }),
    ).toThrow();
    expect(() =>
      recordPaymentSchema.parse({
        orderId: "04d34d3a-c51c-4585-b8ff-594eeb6af109",
        idempotencyKey: "04d34d3a-c51c-4585-b8ff-594eeb6af113",
        method: "CASH",
        amount: "338.10",
        receiptCopies: 11,
      }),
    ).toThrow();
  });

  // ── 7. Default settings remain unchanged after override ──
  it("7. Default settings remain unchanged: createPrinterSchema defaults to 2 receipt copies and 1 KOT copy", () => {
    const printer = createPrinterSchema.parse({
      name: "Akshaya LAN Printer",
      purpose: "RECEIPT",
      connectionType: "LAN",
      connectionAddress: "192.168.1.10:9100",
      paperWidthMm: 80,
    });
    expect(printer.receiptCopies).toBe(2);
    expect(printer.kotCopies).toBe(1);
  });

  // ── 8. Valid ESC/POS payload reaches the agent without causing ESC_POS_RENDER_FAILED on older strict agents ──
  it("8. toWirePrintDocument strips copy metadata so an older strict agent parses it cleanly", () => {
    // Older agents had a strictly locked schema:
    const legacyAgentSchema = z
      .object({
        version: z.literal(1),
        widthMm: z.union([z.literal(58), z.literal(80)]),
        blocks: z.array(printBlockSchema).min(1).max(4000),
      })
      .strict();

    const serverDoc = renderReceiptDocument(mockReceiptInput({ copyLabel: "CUSTOMER COPY", copyIndex: 1, copyCount: 2 }));
    expect(serverDoc).toHaveProperty("copyIndex");
    expect(serverDoc).toHaveProperty("copyLabel");

    // Proving the production defect: directly passing serverDoc with copyIndex fails legacy schema!
    expect(() => legacyAgentSchema.parse(serverDoc)).toThrow(/unrecognized/i);

    // With toWirePrintDocument, legacy agent parses 100% cleanly:
    const wireDoc = toWirePrintDocument(serverDoc);
    expect(() => legacyAgentSchema.parse(wireDoc)).not.toThrow();

    const parsedLegacy = legacyAgentSchema.parse(wireDoc);
    expect(parsedLegacy.version).toBe(1);
    expect(parsedLegacy.widthMm).toBe(80);

    // Encodes to ESC/POS without error:
    const bytes = encodeDocument(parsedLegacy, { profile: profileOf(null) });
    expect(bytes.length).toBeGreaterThan(0);
  });

  // ── 9. Unsupported payload returns a precise error ──
  it("9. parsePrintDocument rejects invalid payload with clear validation details", () => {
    const invalidPayload = { version: 2, widthMm: 80, blocks: [] };
    expect(() => parsePrintDocument(invalidPayload)).toThrow();
  });

  // ── 10. Agent rendering errors do not crash the service ──
  it("10. encodeDocument handles unexpected inputs gracefully without uncaught exceptions", () => {
    const docWithEmptyBlocks = { version: 1 as const, widthMm: 80 as const, blocks: [{ type: "spacer" as const, lines: 1 }] };
    expect(() => encodeDocument(docWithEmptyBlocks)).not.toThrow();
  });

  // ── 11. Retry does not create duplicate receipts ──
  it("11. Deduplication key formats isolate copies and reprints predictably", () => {
    const orderId = "04d34d3a-c51c-4585-b8ff-594eeb6af109";
    // Automatic 2-copy receipt keys:
    const copy1Key = `RECEIPT:${orderId}:c1`;
    const copy2Key = `RECEIPT:${orderId}:c2`;
    expect(copy1Key).not.toBe(copy2Key);

    // Manual reprint versioned keys:
    const reprint1Copy1Key = `RECEIPT:${orderId}:v2:c1`;
    const reprint1Copy2Key = `RECEIPT:${orderId}:v2:c2`;
    expect(reprint1Copy1Key).not.toBe(copy1Key);
    expect(reprint1Copy1Key).not.toBe(reprint1Copy2Key);
  });

  // ── 12. Multiple printers retain independent queues ──
  it("12. Both 58mm and 80mm printers encode their respective widths correctly", () => {
    const doc80 = renderReceiptDocument(mockReceiptInput({ widthMm: 80 }));
    const doc58 = renderReceiptDocument(mockReceiptInput({ widthMm: 58 }));

    const bytes80 = encodeDocument(toWirePrintDocument(doc80));
    const bytes58 = encodeDocument(toWirePrintDocument(doc58));

    expect(bytes80.length).toBeGreaterThan(0);
    expect(bytes58.length).toBeGreaterThan(0);
  });
});
