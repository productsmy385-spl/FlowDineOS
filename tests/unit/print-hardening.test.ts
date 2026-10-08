import { describe, expect, it } from "vitest";
import { PRINT_ERRORS, canonicalPrintErrorCode, describePrintError, type PrintErrorCode } from "@/lib/print/error-codes";
import { PRINTER_PROFILES, profileOf } from "@/lib/print/profiles";
import { renderTestDocument } from "@/lib/print/render-test";
import { AGENT_VERSION_WITH_CODES, agentVersionAtLeast, parsePrintDocument, type PrintDocument } from "@/lib/print/types";
import { ESCPOS, asciiTextRenderer, encodeDocument, type TextRenderer } from "@/print-agent/src/escpos";

/**
 * Printing hardening 2026-10-08 (knowledge/implementation/printing-audit-2026-10-08.md): the error catalogue, printer
 * profiles, QR/barcode gating, the text-renderer seam for future multilingual printing, and the test ticket.
 */
const has = (haystack: Buffer, needle: readonly number[]) => haystack.indexOf(Buffer.from(needle)) >= 0;
const GS_K = [0x1d, 0x28, 0x6b]; // GS ( k — QR

describe("TC-PRINT-040 error catalogue", () => {
  it("every code has a technical line, a plain sentence naming the printer and a retry flag", () => {
    for (const [code, entry] of Object.entries(PRINT_ERRORS) as Array<[PrintErrorCode, (typeof PRINT_ERRORS)[PrintErrorCode]]>) {
      expect(entry.technical.length, code).toBeGreaterThan(10);
      expect(typeof entry.retryable, code).toBe("boolean");
      if (!["ESC_POS_RENDER_FAILED", "PRINT_JOB_CANCELLED"].includes(code)) expect(entry.user("Kitchen Printer"), code).toContain("Kitchen Printer");
    }
  });

  it("an unreachable printer is never explained as a paper problem", () => {
    for (const code of ["PRINTER_UNREACHABLE", "CONNECTION_TIMEOUT", "CONNECTION_REFUSED", "PRINTER_PORT_UNREACHABLE"] as const) {
      const described = describePrintError(code, "Kitchen Printer");
      expect(described.user, code).not.toMatch(/paper|cover/i);
      expect(described.offline, code).toBe(true);
      expect(described.retryable, code).toBe(true);
    }
    expect(describePrintError("CONNECTION_TIMEOUT", "Kitchen Printer").user).toContain("Kitchen Printer is unreachable");
  });

  it("codes from agents older than 2026-10-08 map to the catalogue", () => {
    expect(canonicalPrintErrorCode("PRINTER_OFFLINE")).toBe("PRINTER_UNREACHABLE");
    expect(canonicalPrintErrorCode("TIMEOUT", "Printer at 192.168.1.103:9100 did not accept a connection within 5 s")).toBe("CONNECTION_TIMEOUT");
    expect(canonicalPrintErrorCode("TIMEOUT", "Printer at 192.168.1.103:9100 stopped accepting data")).toBe("DELIVERY_UNKNOWN");
    expect(canonicalPrintErrorCode("WRITE_FAILED")).toBe("PRINT_SEND_FAILED");
    expect(canonicalPrintErrorCode("INVALID_ADDRESS")).toBe("INVALID_PRINTER_CONFIGURATION");
    expect(canonicalPrintErrorCode("INVALID_PAYLOAD")).toBe("ESC_POS_RENDER_FAILED");
    expect(canonicalPrintErrorCode("UNKNOWN_PRINTER")).toBe("PRINTER_NOT_FOUND");
    expect(canonicalPrintErrorCode("PRINTER_DEACTIVATED")).toBe("PRINTER_DISABLED");
    expect(canonicalPrintErrorCode("SOMETHING_NEW")).toBe("PRINT_FAILED");
  });

  it("a partly delivered ticket is never retried automatically", () => {
    expect(PRINT_ERRORS.DELIVERY_UNKNOWN.retryable).toBe(false);
  });
});

describe("TC-PRINT-041 printer profiles drive the ESC/POS bytes", () => {
  const doc = (blocks: PrintDocument["blocks"]): PrintDocument => ({ version: 1, widthMm: 80, blocks });

  it("the TVS RP 3230 profile: 80 mm / 48 columns, partial cut, QR, barcode and bitmap per the spec sheet — not yet hardware-verified", () => {
    expect(PRINTER_PROFILES.TVS_RP3230).toMatchObject({ paperWidthsMm: [80], columns: { 80: 48 }, cut: "partial", supportsQr: true, supportsBarcode: true, supportsBitmap: true, hardwareVerified: false });
    expect(profileOf("NO_SUCH_MODEL").key).toBe("GENERIC_ESCPOS");
  });

  it("a QR code is printed only on a profile that supports it; otherwise only its caption", () => {
    const document = doc([{ type: "qr", data: "FLOWDINEOS", caption: "Scan me" }, { type: "cut" }]);
    const tvs = encodeDocument(document, { profile: PRINTER_PROFILES.TVS_RP3230 });
    const generic = encodeDocument(document, { profile: PRINTER_PROFILES.GENERIC_ESCPOS });
    expect(has(tvs, GS_K)).toBe(true);
    expect(has(generic, GS_K)).toBe(false);
    expect(generic.toString("latin1")).toContain("Scan me");
  });

  it("the cut follows the profile", () => {
    const document = doc([{ type: "text", text: "x" }, { type: "cut" }]);
    expect(has(encodeDocument(document, { profile: { ...PRINTER_PROFILES.GENERIC_ESCPOS, cut: "partial" } }), ESCPOS.cut)).toBe(true);
    expect(has(encodeDocument(document, { profile: { ...PRINTER_PROFILES.GENERIC_ESCPOS, cut: "full" } }), ESCPOS.fullCut)).toBe(true);
    const none = encodeDocument(document, { profile: { ...PRINTER_PROFILES.GENERIC_ESCPOS, cut: "none" } });
    expect(has(none, ESCPOS.cut) || has(none, ESCPOS.fullCut)).toBe(false);
  });

  it("QR data is bounded and printable ASCII only, so it can never smuggle printer commands", () => {
    expect(() => parsePrintDocument(doc([{ type: "qr", data: "a\u001bb" }]))).toThrow();
    expect(() => parsePrintDocument(doc([{ type: "qr", data: "x".repeat(301) }]))).toThrow();
  });

  it("text goes through a replaceable renderer — the seam for future multilingual (raster) printing", () => {
    const seen: string[] = [];
    const recording: TextRenderer = {
      prepare: (text) => asciiTextRenderer.prepare(text),
      line: (text) => {
        seen.push(text);
        return asciiTextRenderer.line(text);
      },
    };
    encodeDocument(doc([{ type: "text", text: "Masala Dosa" }]), { text: recording });
    expect(seen).toContain("Masala Dosa");
    // Today, script the printer cannot show becomes "?" rather than garbage bytes.
    expect(asciiTextRenderer.prepare("దోస")).toBe("???");
  });
});

describe("TC-PRINT-042 test ticket and the QR gate for older agents", () => {
  it("names the restaurant, printer, model, agent, station, connection and protocol — and no address", () => {
    const document = renderTestDocument({
      widthMm: 80,
      restaurantName: "Akshayapatra",
      printerName: "Kitchen Printer",
      requestedAt: new Date("2026-10-08T06:30:00.000Z"),
      timeZone: "Asia/Kolkata",
      modelLabel: "TVS-E RP 3230",
      agentName: "Counter PC",
      stationName: "Kitchen",
      connection: "LAN",
      withQr: true,
    });
    const text = JSON.stringify(document);
    for (const expected of ["FLOWDINEOS", "PRINTER TEST", "Akshayapatra", "Kitchen Printer", "TVS-E RP 3230", "Counter PC", "Ethernet", "ESC/POS", "48 col"]) expect(text).toContain(expected);
    expect(text).not.toMatch(/192\.168\./);
    expect(document.blocks.some((block) => block.type === "qr")).toBe(true);
    expect(renderTestDocument({ widthMm: 80, restaurantName: "R", printerName: "P", requestedAt: new Date(), timeZone: "Asia/Kolkata" }).blocks.some((block) => block.type === "qr")).toBe(false);
  });

  it("agent version comparison", () => {
    expect(agentVersionAtLeast("0.2.0", AGENT_VERSION_WITH_CODES)).toBe(true);
    expect(agentVersionAtLeast("0.10.0", AGENT_VERSION_WITH_CODES)).toBe(true);
    expect(agentVersionAtLeast("0.1.0", AGENT_VERSION_WITH_CODES)).toBe(false);
    expect(agentVersionAtLeast(null, AGENT_VERSION_WITH_CODES)).toBe(false);
    expect(agentVersionAtLeast("garbage", AGENT_VERSION_WITH_CODES)).toBe(false);
  });
});
