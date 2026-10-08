import { profileOf, type PrinterProfile } from "@/lib/print/profiles";
import { fitRow, sanitizeText, wrapText } from "@/lib/print/text";
import { columnsFor, type PrintAlign, type PrintDocument } from "@/lib/print/types";

/**
 * ESC/POS encoder (S1-P17-T005, ADR-007 §8, TC-AGENT-013; printer profiles 2026-10-08).
 *
 * Input is a validated `PrintDocument` and the printer's capability profile (lib/print/profiles.ts); output is the
 * exact byte stream for a 58 mm (32 col) or 80 mm (48 col) roll. Cut type, code page and whether QR codes and barcodes
 * are printed come from the profile, never from an assumption that every ESC/POS printer behaves the same.
 *
 * Only printable ASCII (0x20–0x7E) ever reaches the printer as text. Every string is re-sanitised here even though the
 * server already did it (SC-VAL-07): an ESC or GS byte smuggled into an item name would otherwise be executed by the
 * printer as a command — cut, cash-drawer kick or mode change. Characters the default code page cannot show are
 * transliterated (₹ → "Rs") or replaced with "?", and wrapping is redone after transliteration so a longer
 * replacement can never push text past the roll edge.
 *
 * Multilingual text (owner decision 2026-10-08: not in this iteration) plugs in through {@link TextRenderer}: a raster
 * renderer for a profile with `supportsBitmap` will turn a line into `GS v 0` image bytes. Nothing else changes.
 */
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const ESCPOS = {
  init: [ESC, 0x40],
  /** ESC t n — code page; text is ASCII after transliteration, so this only makes the output deterministic. */
  codePage: (page: number) => [ESC, 0x74, page & 0xff],
  align: (align: PrintAlign) => [ESC, 0x61, align === "center" ? 1 : align === "right" ? 2 : 0],
  bold: (on: boolean) => [ESC, 0x45, on ? 1 : 0],
  /** GS ! n — 0x11 is double width and double height. */
  size: (double: boolean) => [GS, 0x21, double ? 0x11 : 0x00],
  /** GS V 1 — partial cut; GS V 0 — full cut. */
  cut: [GS, 0x56, 0x01],
  fullCut: [GS, 0x56, 0x00],
} as const;

/** Lines fed before a cut so the last printed line clears the cutter blade. */
export const CUT_FEED_LINES = 4;

const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  "₹": "Rs",
  "€": "EUR",
  "£": "GBP",
  "…": ".",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "•": "*",
  "×": "x",
  "°": "o",
};

/** Sanitised, transliterated, printable-ASCII-only text. */
export function toPrinterText(value: string): string {
  let out = "";
  for (const ch of sanitizeText(value)) {
    const mapped = TRANSLITERATIONS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    // "é" → "e", "ñ" → "n"; anything else (Devanagari, Telugu, emoji) → "?" until a raster TextRenderer exists.
    const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += /^[\x20-\x7e]+$/.test(base) ? base : "?";
  }
  return out;
}

/**
 * How text becomes printer bytes. The default sends printable ASCII; a future raster renderer (Indic scripts) returns
 * image bytes for the same line. `prepare` runs before wrapping so the column count is honoured either way.
 */
export interface TextRenderer {
  prepare(text: string): string;
  line(text: string): number[];
}

export const asciiTextRenderer: TextRenderer = {
  prepare: toPrinterText,
  line: (text) => [...Array.from(text, (ch) => ch.charCodeAt(0) & 0x7f), LF],
};

export type EncodeOptions = { profile?: PrinterProfile; text?: TextRenderer };

/** GS ( k — QR model 2: size, error correction M, store, print (ESC/POS function 165/167/169/180/181). */
function qrBytes(data: string, size: number): number[] {
  const bytes = Array.from(data, (ch) => ch.charCodeAt(0) & 0x7f);
  const length = bytes.length + 3;
  return [
    ...[GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0],
    ...[GS, 0x28, 0x6b, 3, 0, 49, 67, Math.min(10, Math.max(2, size))],
    ...[GS, 0x28, 0x6b, 3, 0, 49, 69, 49],
    ...[GS, 0x28, 0x6b, length & 0xff, length >> 8, 49, 80, 48, ...bytes],
    ...[GS, 0x28, 0x6b, 3, 0, 49, 81, 48],
  ];
}

/** GS k 73 — CODE128 (code set B), HRI text below, 80 dots high, module width 2. */
function barcodeBytes(data: string): number[] {
  const bytes = [0x7b, 0x42, ...Array.from(data, (ch) => ch.charCodeAt(0) & 0x7f)];
  return [GS, 0x68, 80, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 73, bytes.length, ...bytes];
}

export function encodeDocument(document: PrintDocument, options: EncodeOptions = {}): Buffer {
  const profile = options.profile ?? profileOf(null);
  const text = options.text ?? asciiTextRenderer;
  const columns = columnsFor(document.widthMm);
  const out: number[] = [...ESCPOS.init, ...ESCPOS.codePage(profile.codePage)];
  const line = (value: string) => out.push(...text.line(value));
  const resetStyle = () => out.push(...ESCPOS.align("left"), ...ESCPOS.bold(false), ...ESCPOS.size(false));
  const caption = (value: string | undefined) => {
    if (!value) return;
    out.push(...ESCPOS.align("center"));
    for (const part of wrapText(text.prepare(value), columns)) line(part);
    out.push(...ESCPOS.align("left"));
  };

  for (const block of document.blocks) {
    switch (block.type) {
      case "text": {
        const double = block.size === "double";
        const lines = wrapText(text.prepare(block.text), double ? Math.floor(columns / 2) : columns);
        out.push(...ESCPOS.align(block.align ?? "left"), ...ESCPOS.bold(block.bold === true), ...ESCPOS.size(double));
        for (const value of lines.length > 0 ? lines : [""]) line(value);
        resetStyle();
        break;
      }
      case "row": {
        const right = text.prepare(block.right);
        if (block.bold) out.push(...ESCPOS.bold(true));
        if (right.length >= columns - 1) {
          // An amount wider than the roll: print the label, then the amount right-aligned on its own lines.
          for (const value of wrapText(text.prepare(block.left), columns)) line(value);
          out.push(...ESCPOS.align("right"));
          for (const value of wrapText(right, columns)) line(value);
          out.push(...ESCPOS.align("left"));
        } else {
          const fitted = fitRow(text.prepare(block.left), right, columns);
          const left = text.prepare(fitted.left); // fitRow's ellipsis becomes "." — same width
          line(`${left}${" ".repeat(Math.max(1, columns - left.length - right.length))}${right}`);
        }
        if (block.bold) out.push(...ESCPOS.bold(false));
        break;
      }
      case "divider":
        line((block.style === "solid" ? "=" : "-").repeat(columns));
        break;
      case "spacer":
        for (let i = 0; i < block.lines; i++) out.push(LF);
        break;
      case "qr":
        // A printer without QR support gets the caption only — never commands it may print as garbage.
        if (profile.supportsQr) {
          out.push(...ESCPOS.align("center"), ...qrBytes(toPrinterText(block.data), block.size ?? 6), LF, ...ESCPOS.align("left"));
        }
        caption(block.caption);
        break;
      case "barcode":
        if (profile.supportsBarcode) out.push(...ESCPOS.align("center"), ...barcodeBytes(toPrinterText(block.data)), LF, ...ESCPOS.align("left"));
        caption(block.caption);
        break;
      case "cut":
        for (let i = 0; i < CUT_FEED_LINES; i++) out.push(LF);
        if (profile.cut === "partial") out.push(...ESCPOS.cut);
        else if (profile.cut === "full") out.push(...ESCPOS.fullCut);
        break;
    }
  }
  return Buffer.from(out);
}
