import { zip } from "./zip";

/**
 * CSV and Excel (.xlsx) writers, plus a CSV reader, for restaurant backups (RASOIOS-ADR-021).
 *
 * Cells arrive already flattened to `string | number | boolean | null` (see `flattenRow`). Money stays a decimal
 * string all the way: it is written into the file exactly as PostgreSQL returned it, never through a float.
 */
export type Cell = string | number | boolean | null;
export type Sheet = { name: string; columns: string[]; rows: Cell[][] };

/**
 * A spreadsheet treats a cell that starts with = + - @ (or a tab / carriage return) as a formula, so a customer name
 * like `=HYPERLINK(...)` would run when the restaurant opens its own backup. Such text is prefixed with an apostrophe.
 * Numbers are written as numbers and are not affected.
 */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: Cell): string {
  if (value === null) return "";
  const text = typeof value === "string" ? neutraliseFormula(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a UTF-8 byte-order mark, so Excel shows ₹ and non-Latin names correctly. */
export function toCsv(sheet: Sheet): Buffer {
  const lines = [sheet.columns.map(csvCell).join(","), ...sheet.rows.map((row) => row.map(csvCell).join(","))];
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

/** Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF). Returns the header and the data rows. */
export function parseCsv(text: string): { columns: string[]; rows: string[][] } {
  const source = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  const [header = [], ...rows] = nonEmpty;
  // Undo our own formula guard on the way back in, so an exported "'=x" round-trips to "=x".
  const unguard = (c: string) => (/^'[=+\-@\t\r]/.test(c) ? c.slice(1) : c);
  return { columns: header.map((c) => c.trim()), rows: rows.map((r) => r.map(unguard)) };
}

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 cannot carry most control characters; drop them rather than produce a file Excel refuses to open.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Sheet names: at most 31 characters, none of []:*?/\ , unique within the workbook. */
function sheetNames(sheets: readonly Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet) => {
    const base = sheet.name.replace(/[[\]:*?/\\]/g, " ").slice(0, 28) || "Sheet";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function sheetXml(sheet: Sheet): string {
  const cell = (value: Cell, ref: string): string => {
    if (value === null) return "";
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const text = String(value);
    // A decimal string from the database (money, quantities) is written as a number cell, digit for digit.
    if (/^-?\d{1,15}(\.\d{1,6})?$/.test(text) && !/^0\d/.test(text)) return `<c r="${ref}"><v>${text}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(neutraliseFormula(text))}</t></is></c>`;
  };
  const rows = [sheet.columns as Cell[], ...sheet.rows].map(
    (row, r) => `<row r="${r + 1}">${row.map((value, c) => cell(value, `${columnName(c)}${r + 1}`)).join("")}</row>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

/** A minimal Office Open XML workbook: one worksheet per sheet, header row frozen, inline strings. */
export function toXlsx(sheets: readonly Sheet[], at: Date = new Date()): Buffer {
  const list = sheets.length > 0 ? sheets : [{ name: "Empty", columns: ["No data"], rows: [] }];
  const names = sheetNames(list);
  const files = [
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `</Relationships>`,
    },
    ...list.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })), at);
}
