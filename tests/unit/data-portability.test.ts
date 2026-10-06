import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { coerceRow, columnsOf, tenantReferences, userReferences } from "@/lib/data/backup-validate";
import { neutraliseFormula, parseCsv, toCsv, toXlsx } from "@/lib/data-portability/tabular";
import { unzip, zip, ZipError } from "@/lib/data-portability/zip";

// TC-DATA-020…023 — backup file formats and import validation (RASOIOS-ADR-021).
const ID = "7f3e2b1a-9c4d-4e8f-a1b2-c3d4e5f60718";

describe("TC-DATA-020 ZIP", () => {
  it("round-trips files byte for byte", () => {
    const files = [
      { name: "backup.json", data: Buffer.from('{"a":1}') },
      { name: "csv/orders.csv", data: Buffer.from("id,total\r\n1,210.00\r\n") },
    ];
    expect(unzip(zip(files), { maxEntries: 10, maxTotalBytes: 1024 })).toEqual(files);
  });

  it("refuses archives that are too large, have too many files, or use path tricks", () => {
    expect(() => unzip(zip([{ name: "a.json", data: Buffer.alloc(5000) }]), { maxEntries: 10, maxTotalBytes: 1000 })).toThrow(ZipError);
    const two = zip([
      { name: "a", data: Buffer.from("x") },
      { name: "b", data: Buffer.from("y") },
    ]);
    expect(() => unzip(two, { maxEntries: 1, maxTotalBytes: 1000 })).toThrow(/at most 1/);
    expect(() => unzip(zip([{ name: "../evil.json", data: Buffer.from("x") }]), { maxEntries: 10, maxTotalBytes: 1000 })).toThrow(/unexpected file name/);
    expect(() => unzip(Buffer.from("not a zip at all, just text"), { maxEntries: 10, maxTotalBytes: 1000 })).toThrow(/not a ZIP/);
  });
});

describe("TC-DATA-021 CSV", () => {
  it("quotes, escapes and round-trips text, and keeps money as written", () => {
    const csv = toCsv({
      name: "x",
      columns: ["name", "amount"],
      rows: [
        ['Masala, "special"\nline 2', "210.50"],
        [null, "0.10"],
      ],
    }).toString("utf8");
    expect(csv.startsWith("﻿")).toBe(true);
    const parsed = parseCsv(csv);
    expect(parsed.columns).toEqual(["name", "amount"]);
    expect(parsed.rows).toEqual([
      ['Masala, "special"\nline 2', "210.50"],
      ["", "0.10"],
    ]);
  });

  it("neutralises spreadsheet formulas on the way out and restores the text on the way in", () => {
    for (const evil of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\t=x"]) expect(neutraliseFormula(evil)).toBe(`'${evil}`);
    expect(neutraliseFormula("Paneer")).toBe("Paneer");
    expect(parseCsv(toCsv({ name: "x", columns: ["n"], rows: [["=HYPERLINK(1)"]] }).toString("utf8")).rows[0][0]).toBe("=HYPERLINK(1)");
  });
});

describe("TC-DATA-022 Excel", () => {
  it("is an Office Open XML package with one sheet per table and number cells for amounts", () => {
    const file = toXlsx([{ name: "Orders", columns: ["id", "total", "note"], rows: [["o1", "210.00", "=bad()"]] }]);
    const parts = Object.fromEntries(
      // The package's own part names include brackets, which a backup import would refuse; read them directly here.
      unzipLoose(file).map((p) => [p.name, p.data.toString("utf8")]),
    );
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]));
    expect(parts["xl/workbook.xml"]).toContain('name="Orders"');
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("<v>210.00</v>");
    expect(parts["xl/worksheets/sheet1.xml"]).toContain("'=bad()");
  });
});

describe("TC-DATA-023 import validation follows the schema", () => {
  it("accepts a well-formed row and ignores tenantId and unknown keys", () => {
    const { row, issues } = coerceRow("Customer", {
      id: ID,
      tenantId: "00000000-0000-0000-0000-000000000000",
      fullName: "Asha Rao",
      sneaky: "drop me",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(issues).toEqual([]);
    expect(row).not.toHaveProperty("tenantId");
    expect(row).not.toHaveProperty("sneaky");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("explains what is wrong with a bad row", () => {
    const issues = coerceRow("Transaction", { id: "not-a-uuid", amount: 210.5, paymentMethod: "BITCOIN", orderId: ID }).issues.join("; ");
    expect(issues).toMatch(/id is not a valid id/);
    expect(issues).toMatch(/amount must be a decimal amount written as text/);
    expect(issues).toMatch(/paymentMethod is not one of the allowed values/);
    expect(issues).toMatch(/is missing type/);
  });

  it("checks money precision and text length from the column definitions", () => {
    expect(coerceRow("Transaction", { amount: "10.123" }).issues.join()).toMatch(/amount does not fit 12,2/);
    expect(coerceRow("Customer", { id: ID, fullName: "x".repeat(500) }).issues.join()).toMatch(/fullName is longer than/);
  });

  it("reads spreadsheet-style values from CSV", () => {
    const { row, issues } = coerceRow("DiningTable", { id: ID, label: "T1", publicCode: "abcdefghjk", isActive: "false", sortOrder: "3", archivedAt: "" }, true);
    expect(issues).toEqual([]);
    expect(row).toMatchObject({ isActive: false, sortOrder: 3, archivedAt: null });
  });

  it("knows which columns link to the same restaurant and which name a person", () => {
    expect(tenantReferences("OrderItem").map((r) => r.column)).toEqual(expect.arrayContaining(["orderId", "menuItemId", "variantId", "kitchenSectionId"]));
    expect(userReferences("Transaction")).toEqual(expect.arrayContaining(["recordedByUserId", "voidedByUserId"]));
    expect(columnsOf("StaffSession", ["tokenHash"]).map((f) => f.name)).not.toContain("tokenHash");
  });
});

/** Minimal central-directory walk without the import guard's file-name rule, for inspecting an .xlsx in tests. */
function unzipLoose(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const skip = nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, data: inflateRawSync(buf.subarray(start, start + size)) });
    p += 46 + skip;
  }
  return out;
}
