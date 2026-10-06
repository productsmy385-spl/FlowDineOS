import { unzip, ZipError } from "./zip";

/**
 * Reads the first worksheet of an Excel (.xlsx) file as a header row plus data rows of text (RASOIOS-ADR-022).
 *
 * Office Open XML is a ZIP of XML parts; this reads exactly the parts a plain sheet needs — the workbook, its
 * relationships, the shared-strings table and the first sheet — with the same size and entry limits as a backup.
 * Formulas are never evaluated: a cell yields its cached value, or nothing. Numbers come back exactly as Excel stored
 * them in the file, as text.
 */

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** All the text runs inside one `<si>` / `<is>` element, joined. */
const runs = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsxTable(bytes: Buffer): { columns: string[]; rows: string[][] } {
  let parts: Map<string, string>;
  try {
    parts = new Map(unzip(bytes, { maxEntries: 500, maxTotalBytes: 120 * 1024 * 1024 }).map((e) => [e.name, e.data.toString("utf8")]));
  } catch (error) {
    throw new ZipError(error instanceof ZipError ? `This Excel file could not be read: ${error.message}` : "This Excel file could not be read.");
  }
  const workbook = parts.get("xl/workbook.xml");
  if (!workbook) throw new ZipError("This is not an Excel workbook (.xlsx).");
  const firstSheetRel = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = parts.get("xl/_rels/workbook.xml.rels") ?? "";
  const target = firstSheetRel ? new RegExp(`<Relationship\\b[^>]*Id="${firstSheetRel}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstSheetRel}"`).exec(rels)?.[1] : undefined;
  const sheetPath = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  const sheet = parts.get(sheetPath);
  if (!sheet) throw new ZipError("The workbook has no readable first sheet.");

  const shared = [...(parts.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]));

  const table: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = runs(body);
      else if (type === "b") value = raw === "1" ? "true" : "false";
      else if (raw !== undefined) value = decode(raw);
      const index = ref ? columnIndex(ref) : cells.length;
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    table.push(cells);
  }
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ""));
  const [header = [], ...rows] = nonEmpty;
  // Undo the formula guard our own exports add, so an exported "'=x" reads back as "=x".
  const unguard = (c: string) => (/^'[=+\-@\t\r]/.test(c) ? c.slice(1) : c);
  return { columns: header.map((c) => c.trim()), rows: rows.map((r) => r.map(unguard)) };
}
