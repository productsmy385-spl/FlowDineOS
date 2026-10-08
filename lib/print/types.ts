import { z } from "zod";
import { ValidationError } from "@/lib/errors";

/**
 * `PrintDocument` v1 — the printer-agnostic payload contract (S1-P16-T002, architecture.md §6.4, ADR-007 §8).
 *
 * The server renders this structure; the local agent encodes ESC/POS for the printer's configured width and codepage.
 * A document carries only what is printed on the ticket: no internal ids beyond the job id, no customer contact
 * details, no secrets (SC-PRINT-07). It is validated with Zod on write (here) and again on read by the agent, and the
 * serialised payload is capped at 64 KB so one malformed order cannot fill the queue.
 */

export const PAPER_WIDTHS = [58, 80] as const;
export type PaperWidthMm = (typeof PAPER_WIDTHS)[number];

/** Printable columns of a thermal roll at the default font: 58 mm → 32, 80 mm → 48. */
export const PAPER_COLUMNS: Readonly<Record<PaperWidthMm, 32 | 48>> = { 58: 32, 80: 48 };

/** Any stored `paper_width_mm` narrowed to a supported roll (the column is SMALLINT, so it is not a union at rest). */
export function paperWidthOf(widthMm: number | null | undefined): PaperWidthMm {
  return widthMm === 58 ? 58 : 80;
}

export function columnsFor(widthMm: number | null | undefined): 32 | 48 {
  return PAPER_COLUMNS[paperWidthOf(widthMm)];
}

export type PrintAlign = "left" | "center" | "right";

export type PrintBlock =
  | { type: "text"; text: string; align?: PrintAlign; bold?: boolean; size?: "normal" | "double" }
  | { type: "row"; left: string; right: string; bold?: boolean }
  | { type: "divider"; style?: "dashed" | "solid" }
  | { type: "spacer"; lines: number }
  | { type: "cut" }
  /**
   * QR code / CODE128 barcode (2026-10-08). Printed only by agents ≥ {@link AGENT_VERSION_WITH_CODES} on a printer whose
   * profile supports it; the server never sends them to older agents, which would refuse the whole ticket.
   */
  | { type: "qr"; data: string; size?: number; caption?: string }
  | { type: "barcode"; data: string; caption?: string };

/** The first agent version that prints `qr` and `barcode` blocks. */
export const AGENT_VERSION_WITH_CODES = "0.2.0";

/** True when `version` (e.g. "0.10.1") is at least `minimum`. Unknown or malformed versions are false. */
export function agentVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const parse = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null);
  const have = version ? parse(version) : null;
  const want = parse(minimum);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

export type PrintDocument = {
  version: 1;
  widthMm: PaperWidthMm;
  blocks: PrintBlock[];
};

const alignSchema = z.enum(["left", "center", "right"]);

export const printBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(400),
      align: alignSchema.optional(),
      bold: z.boolean().optional(),
      size: z.enum(["normal", "double"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("row"), left: z.string().max(200), right: z.string().max(200), bold: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("divider"), style: z.enum(["dashed", "solid"]).optional() }).strict(),
  z.object({ type: z.literal("spacer"), lines: z.number().int().min(1).max(8) }).strict(),
  z.object({ type: z.literal("cut") }).strict(),
  // Printable ASCII only: the data is sent to the printer as bytes.
  z.object({ type: z.literal("qr"), data: z.string().min(1).max(300).regex(/^[ -~]+$/), size: z.number().int().min(2).max(10).optional(), caption: z.string().max(60).optional() }).strict(),
  z.object({ type: z.literal("barcode"), data: z.string().min(1).max(40).regex(/^[ -~]+$/), caption: z.string().max(60).optional() }).strict(),
]);

export const printDocumentSchema = z
  .object({
    version: z.literal(1),
    widthMm: z.union([z.literal(58), z.literal(80)]),
    blocks: z.array(printBlockSchema).min(1).max(4000),
  })
  .strict();

/** ADR-007 §8 / architecture.md §6.4 — payloads are capped at 64 KB. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export function payloadBytes(document: unknown): number {
  return Buffer.byteLength(JSON.stringify(document) ?? "", "utf8");
}

/**
 * Validates a rendered document and enforces the size cap. A document that does not fit is a 422 rather than a row
 * the agent can never print — the caller (a KOT or receipt producer) surfaces it with the business error.
 */
export function assertPrintable(document: PrintDocument): PrintDocument {
  const parsed = printDocumentSchema.parse(document) as PrintDocument;
  if (payloadBytes(parsed) > MAX_PAYLOAD_BYTES) {
    throw new ValidationError("This ticket is too large to print. Split the order into smaller rounds.", undefined, "PRINT_DOCUMENT_TOO_LARGE");
  }
  return parsed;
}

/** Parses a payload read back from the database (the agent does the same before encoding). */
export function parsePrintDocument(payload: unknown): PrintDocument {
  return printDocumentSchema.parse(payload) as PrintDocument;
}
