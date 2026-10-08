import { printableTimestamp } from "./format";
import { fitRow, sanitizeLine, wrapText } from "./text";
import { assertPrintable, columnsFor, paperWidthOf, type PaperWidthMm, type PrintBlock, type PrintDocument } from "./types";

/**
 * Test page (S1-P16-T002, api.md SA-PRN-04; layout per owner brief 2026-10-08 §12). Everything on it is server-built:
 * the restaurant, the printer and its model, the agent and station it belongs to, how it is connected, and the instant
 * the request was made in the restaurant's time zone. A staff member holding the slip can tell exactly which printer
 * produced it, and whether the roll width and the cutter are set up correctly. No secrets, no addresses.
 *
 * `withQr` adds a QR code only when the agent can print one and the printer's profile supports it (the caller decides);
 * a scannable square proves the printer's QR support during hardware acceptance.
 */
export type TestDocumentInput = {
  widthMm: number;
  restaurantName: string;
  printerName: string;
  requestedAt: Date;
  timeZone: string;
  modelLabel?: string;
  agentName?: string | null;
  stationName?: string | null;
  connection?: "LAN" | "USB";
  withQr?: boolean;
};

export function renderTestDocument(input: TestDocumentInput): PrintDocument {
  const widthMm: PaperWidthMm = paperWidthOf(input.widthMm);
  const columns = columnsFor(widthMm);
  const line = (text: string, extra: Omit<Extract<PrintBlock, { type: "text" }>, "type" | "text"> = {}): PrintBlock[] =>
    wrapText(text, columns).map((part) => ({ type: "text" as const, text: part, ...extra }));
  const row = (left: string, right: string): PrintBlock => ({ type: "row", ...fitRow(left, right, columns) });

  return assertPrintable({
    version: 1,
    widthMm,
    blocks: [
      { type: "text", text: "FLOWDINEOS", align: "center", bold: true, size: "double" },
      { type: "text", text: "PRINTER TEST", align: "center", bold: true },
      { type: "divider", style: "solid" },
      row("Restaurant", sanitizeLine(input.restaurantName, 40)),
      row("Printer", sanitizeLine(input.printerName, 30)),
      ...(input.modelLabel ? [row("Model", sanitizeLine(input.modelLabel, 30))] : []),
      row("Agent", sanitizeLine(input.agentName ?? "Not assigned", 30)),
      row("Station", sanitizeLine(input.stationName ?? "Any station", 30)),
      row("Time", printableTimestamp(input.requestedAt, input.timeZone)),
      row("Connection", input.connection === "USB" ? "USB" : "Ethernet / Wi-Fi"),
      row("Protocol", "ESC/POS"),
      row("Paper", `${widthMm} mm / ${columns} col`),
      { type: "divider", style: "dashed" },
      ...(input.withQr ? ([{ type: "qr", data: "FLOWDINEOS PRINTER TEST", size: 6, caption: "QR code check" }, { type: "divider", style: "dashed" }] satisfies PrintBlock[]) : []),
      ...line("If this slip is readable, the lines fit the roll and it was cut, the printer is set up correctly.", { align: "center" }),
      { type: "spacer", lines: 2 },
      { type: "cut" },
    ],
  });
}
