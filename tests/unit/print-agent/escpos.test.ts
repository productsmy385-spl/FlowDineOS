import { describe, expect, it } from "vitest";
import { renderTestDocument } from "@/lib/print/render-test";
import type { PrintDocument } from "@/lib/print/types";
import { CUT_FEED_LINES, encodeDocument, toPrinterText } from "@/print-agent/src/escpos";
import { decodeEscPos, printedText } from "@/tools/printer-simulator/decode";

/** TC-AGENT-013 — ESC/POS output for 58 and 80 mm rolls (S1-P17-T005). */
const kot = (widthMm: 58 | 80): PrintDocument => ({
  version: 1,
  widthMm,
  blocks: [
    { type: "text", text: "AKSHAYPATRA", align: "center", bold: true },
    { type: "text", text: "KOT #1024", align: "center", size: "double" },
    { type: "divider" },
    { type: "row", left: "2 x Masala Dosa", right: "₹240.00" },
    { type: "row", left: "1 x Idly with extra sambar and coconut chutney on the side", right: "₹60.00" },
    { type: "text", text: "Note: less spicy" },
    { type: "divider", style: "solid" },
    { type: "row", left: "Total", right: "₹300.00", bold: true },
    { type: "spacer", lines: 1 },
    { type: "cut" },
  ],
});

describe("TC-AGENT-013 encoder", () => {
  it("golden bytes for a minimal ticket", () => {
    const bytes = encodeDocument({ version: 1, widthMm: 58, blocks: [{ type: "text", text: "Hi", align: "center", bold: true }, { type: "cut" }] });
    expect([...bytes]).toEqual([
      0x1b, 0x40, // ESC @
      0x1b, 0x74, 0x00, // ESC t 0
      0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01, 0x1d, 0x21, 0x00, // center, bold on, normal size
      0x48, 0x69, 0x0a, // "Hi" LF
      0x1b, 0x61, 0x00, 0x1b, 0x45, 0x00, 0x1d, 0x21, 0x00, // reset
      ...Array(CUT_FEED_LINES).fill(0x0a),
      0x1d, 0x56, 0x01, // GS V 1 partial cut
    ]);
  });

  for (const width of [58, 80] as const) {
    const columns = width === 58 ? 32 : 48;
    it(`${width} mm: every line fits ${columns} columns and amounts stay right-aligned`, () => {
      const decoded = decodeEscPos(encodeDocument(kot(width)));
      expect(decoded.unknown).toEqual([]);
      expect(decoded.cuts).toBe(1);
      for (const line of decoded.lines) expect(line.length).toBeLessThanOrEqual(columns);

      const text = printedText(decoded);
      expect(text).toContain("AKSHAYPATRA");
      const total = decoded.lines.find((line) => line.startsWith("Total"))!;
      expect(total).toHaveLength(columns);
      expect(total.endsWith("Rs300.00")).toBe(true);
      expect(decoded.lines).toContain("-".repeat(columns));
      expect(decoded.lines).toContain("=".repeat(columns));
    });
  }

  it("double-size text wraps at half the columns", () => {
    const decoded = decodeEscPos(encodeDocument({ version: 1, widthMm: 58, blocks: [{ type: "text", text: "KITCHEN ORDER TICKET NUMBER", size: "double" }] }));
    for (const line of decoded.lines) expect(line.length).toBeLessThanOrEqual(16);
  });

  it("encodes the server's real test page", () => {
    const document = renderTestDocument({ widthMm: 80, restaurantName: "Akshaypatra - Devarapalli", printerName: "Kitchen Printer", requestedAt: new Date("2026-09-23T05:12:00Z"), timeZone: "Asia/Kolkata" });
    const text = printedText(decodeEscPos(encodeDocument(document)));
    expect(text).toContain("PRINTER TEST");
    expect(text.join("\n")).toContain("Kitchen Printer");
  });
});

describe("TC-AGENT-013 text safety (SC-VAL-07)", () => {
  it("strips ESC/POS commands smuggled into text — no drawer kick, no extra cut", () => {
    const hostile = `Dosa\x1b\x70\x00\x19\xfa\x1d\x56\x00END`;
    const decoded = decodeEscPos(encodeDocument({ version: 1, widthMm: 80, blocks: [{ type: "text", text: hostile }, { type: "row", left: hostile, right: "1" }] }));
    expect(decoded.unknown).toEqual([]);
    expect(decoded.cuts).toBe(0);
  });

  it("transliterates what the code page cannot show", () => {
    expect(toPrinterText("₹120 – Café “special”…")).toBe('Rs120 - Cafe "special".');
    expect(toPrinterText("దోశ")).toBe("???");
  });
});
