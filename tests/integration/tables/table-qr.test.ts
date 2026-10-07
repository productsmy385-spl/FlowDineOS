import jsQR from "jsqr";
import { NextRequest } from "next/server";
import { GET as downloadQrCodes } from "@/app/api/v1/tables/qr-codes/route";
import { unzip } from "@/lib/data-portability/zip";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import TableMenuPage from "@/app/r/[slug]/t/[code]/page";
import { addTablesAction, archiveTableAction, editTableAction, listTablesAction, rotateTableCodeAction } from "@/app/restaurant/tables/actions";
import { findPublicTable } from "@/lib/data/dining-tables";
import { qrMatrix } from "@/lib/qr";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, invokeLoader, seedOnce, tenantIdOf } from "../helpers/actors";
import { RANDOM_UUID } from "../orders/helpers";

/**
 * TC-TBL-001…006 — table QR menus (RASOIOS-ADR-021; owner brief 2026-10-06 §11, §30 "QR").
 * A table's QR resolves to the right restaurant and table on the server, carries no internal id, and stops working the
 * moment its table is switched off, removed or given a new code.
 */
const db = testDb();
const A = tenantIdOf("A");
const B = tenantIdOf("B");

beforeAll(seedOnce, 120_000);

// Some tests publish the seeded websites so their QR pages resolve; put each restaurant back as it was.
let published: { tenantId: string; websitePublished: boolean }[] = [];
beforeAll(async () => {
  published = await db.restaurant.findMany({ where: { tenantId: { in: [A, B] } }, select: { tenantId: true, websitePublished: true } });
});
afterEach(async () => {
  for (const row of published) await db.restaurant.updateMany({ where: { tenantId: row.tenantId }, data: { websitePublished: row.websitePublished } });
});

const slugOf = async (tenantId: string) => (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).slug;
const ok = <T,>(result: unknown) => {
  expect(result).toMatchObject({ ok: true });
  return (result as { data: T }).data;
};

/** Decodes a QR the way a phone camera would: render the modules to pixels and read them back. */
function decode(text: string): string | null {
  const matrix = qrMatrix(text);
  const scale = 6;
  const quiet = 4;
  const size = (matrix.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
    }),
  );
  return jsQR(pixels, size, size)?.data ?? null;
}

async function tableNamed(tenantId: string, label: string) {
  return db.diningTable.findFirstOrThrow({ where: { tenantId, label, archivedAt: null } });
}

describe("TC-TBL-001 adding tables gives each a working QR without internal ids", () => {
  it("numbered tables get unique random codes, and each QR scans to the restaurant's own table address", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { count: 3 }));
    const view = ok<{ tables: { label: string; url: string; qr: { d: string } }[] }>(await invokeAction(listTablesAction));
    const labels = view.tables.map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining(["Table 01", "Table 02", "Table 03"]));

    const slug = await slugOf(A);
    for (const table of view.tables.filter((t) => t.label.startsWith("Table 0"))) {
      const row = await tableNamed(A, table.label);
      expect(row.publicCode).toMatch(/^[a-z2-9]{10}$/);
      expect(table.url).toMatch(new RegExp(`/r/${slug}/t/${row.publicCode}$|^https://${slug}\\.[^/]+/t/${row.publicCode}$`));
      expect(table.url).not.toContain(A);
      expect(table.url).not.toContain(row.id);
      expect(decode(table.url)).toBe(table.url);
    }
    expect(await db.auditLog.count({ where: { tenantId: A, action: "dining_table.created" } })).toBeGreaterThanOrEqual(3);
  });

  it("a second table with the same name is refused, whatever the letter case", async () => {
    await asSeedUser("A", "MANAGER");
    ok(await invokeAction(addTablesAction, { label: "Patio 7" }));
    expect(await invokeAction(addTablesAction, { label: "PATIO 7" })).toMatchObject({ ok: false, error: { code: "TABLE_LABEL_TAKEN" } });
  });
});

describe("TC-TBL-002 the QR resolves on the server to exactly one restaurant's table", () => {
  it("the right slug and code find the table; another restaurant's slug with the same code finds nothing", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "Window 1" }));
    const table = await tableNamed(A, "Window 1");
    const [slugA, slugB] = [await slugOf(A), await slugOf(B)];
    await db.restaurant.updateMany({ where: { tenantId: { in: [A, B] } }, data: { websitePublished: true } });

    expect(await findPublicTable(slugA, table.publicCode)).toEqual({ label: "Window 1" });
    expect(await findPublicTable(slugB, table.publicCode)).toBeNull();
    expect(await invokeLoader(TableMenuPage, { params: Promise.resolve({ slug: slugB, code: table.publicCode }) })).toEqual({ notFound: true });
    expect(await invokeLoader(TableMenuPage, { params: Promise.resolve({ slug: slugA, code: table.publicCode }) })).not.toEqual({ notFound: true });
  });

  it("switching a table off, giving it a new code or removing it retires the printed QR at once", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "Bar 2" }));
    const slugA = await slugOf(A);
    await db.restaurant.updateMany({ where: { tenantId: A }, data: { websitePublished: true } });
    const original = await tableNamed(A, "Bar 2");

    ok(await invokeAction(editTableAction, { id: original.id, isActive: false }));
    expect(await findPublicTable(slugA, original.publicCode)).toBeNull();
    ok(await invokeAction(editTableAction, { id: original.id, isActive: true }));

    ok(await invokeAction(rotateTableCodeAction, { id: original.id }));
    const rotated = await tableNamed(A, "Bar 2");
    expect(rotated.publicCode).not.toBe(original.publicCode);
    expect(await findPublicTable(slugA, original.publicCode)).toBeNull();
    expect(await findPublicTable(slugA, rotated.publicCode)).toEqual({ label: "Bar 2" });

    ok(await invokeAction(archiveTableAction, { id: original.id }));
    expect(await findPublicTable(slugA, rotated.publicCode)).toBeNull();
  });

  it("malformed codes and slugs are refused before any lookup", async () => {
    expect(await findPublicTable("not a slug!", "abcdefghjk")).toBeNull();
    expect(await findPublicTable(await slugOf(A), "../../etc")).toBeNull();
  });
});

describe("TC-TBL-003 tables are managed only by the owner/administrator and managers, each within their own restaurant", () => {
  it.each(["CASHIER", "KITCHEN", "WAITER"] as const)("%s cannot manage tables", async (role) => {
    await asSeedUser("A", role);
    expect(await invokeAction(addTablesAction, { label: "Nope" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("Tenant A cannot rename, rotate or remove Tenant B's table", async () => {
    await asSeedUser("B", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "B Terrace" }));
    const bTable = await tableNamed(B, "B Terrace");
    await asSeedUser("A", "TENANT_ADMIN");
    expect(await invokeAction(editTableAction, { id: bTable.id, label: "Hijacked" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await invokeAction(rotateTableCodeAction, { id: bTable.id })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await invokeAction(archiveTableAction, { id: bTable.id })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: bTable.id } })).label).toBe("B Terrace");
  });

  it("a tenant id smuggled into the input is rejected", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect(await invokeAction(editTableAction, { id: RANDOM_UUID, label: "x", tenantId: B } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("TC-TBL-004 every live table's QR downloads as one ZIP", () => {
  const download = (site = "same-origin") => downloadQrCodes(new NextRequest("http://localhost:3000/api/v1/tables/qr-codes", { headers: { "sec-fetch-site": site } }), undefined as never);

  it("holds one SVG per live table of this restaurant and none of another's", async () => {
    await asSeedUser("B", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "B Only" }));
    await asSeedUser("A", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "Zip 1" }));
    ok(await invokeAction(addTablesAction, { label: "Zip Off" }));
    const off = await tableNamed(A, "Zip Off");
    ok(await invokeAction(editTableAction, { id: off.id, isActive: false }));

    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const files = unzip(Buffer.from(await response.arrayBuffer()), { maxEntries: 500, maxTotalBytes: 50 * 1024 * 1024 });
    const names = files.map((f) => f.name);
    expect(names).toContain("zip-1.svg");
    expect(names).not.toContain("zip-off.svg");
    expect(names).not.toContain("b-only.svg");
    const live = await db.diningTable.count({ where: { tenantId: A, isActive: true, archivedAt: null } });
    expect(files).toHaveLength(live);
    expect(files[0].data.toString("utf8")).toMatch(/^<svg /);
  });

  it("is refused to staff roles and to cross-site requests", async () => {
    await asSeedUser("A", "CASHIER");
    expect((await download()).status).toBe(403);
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await download("cross-site")).status).toBe(403);
  });
});

describe("TC-TBL-005 a seated guest sees the available menu even before the website is published", () => {
  it("renders the table menu for an unpublished website, without sold-out dishes", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    ok(await invokeAction(addTablesAction, { label: "Unpublished 1" }));
    const table = await tableNamed(A, "Unpublished 1");
    await db.restaurant.updateMany({ where: { tenantId: A }, data: { websitePublished: false } });
    const soldOut = await db.menuItem.findFirstOrThrow({ where: { tenantId: A, archivedAt: null, isPublished: true } });
    await db.menuItem.update({ where: { id: soldOut.id }, data: { isAvailable: false } });
    try {
      const element = await invokeLoader(TableMenuPage, { params: Promise.resolve({ slug: await slugOf(A), code: table.publicCode }) });
      expect(element).not.toEqual({ notFound: true });
      const html = renderToStaticMarkup(element as ReactElement);
      expect(html).toContain("Unpublished 1");
      expect(html).not.toContain(`>${soldOut.name}<`);
    } finally {
      await db.menuItem.update({ where: { id: soldOut.id }, data: { isAvailable: true } });
    }
  });
});
