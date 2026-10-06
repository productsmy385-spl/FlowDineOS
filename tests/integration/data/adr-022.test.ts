import type { ReactElement } from "react";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "@/app/api/v1/data/export/route";
import { POST as importRoute } from "@/app/api/v1/data/import/route";
import PublicRestaurantPage from "@/app/r/[slug]/page";
import { archivePrintJobsAction } from "@/app/restaurant/printing/actions";
import { updateWebsiteThemeAction } from "@/app/restaurant/website/actions";
import { toXlsx } from "@/lib/data-portability/tabular";
import { createCategory, createCustomer, createMembership, createMenuItem, createOrder, createPayment, createPrintJob, createPrinter, createTenant, createUser } from "../../factories";
import { testDb } from "../setup/db";
import { actorState } from "../helpers/actor-state";
import { asAnonymous, asSeedUser, asUserId, invokeAction, invokeLoader, seedOnce, tenantIdOf } from "../helpers/actors";

/**
 * TC-ADR22-001…012 — owner review 2026-10-06: spreadsheet imports, the reports export, brand colours, the menu
 * presentation setting and print-history clean-up (RASOIOS-ADR-022).
 */
const db = testDb();
const APP = "http://localhost:3000";
const A = tenantIdOf("A");
const B = tenantIdOf("B");

beforeAll(seedOnce, 120_000);

async function importList(kind: "customers" | "menuItems", file: { name: string; bytes: Buffer }, mode: "preview" | "commit") {
  const form = new FormData();
  form.append("mode", mode);
  form.append("kind", kind);
  form.append("file", new File([new Uint8Array(file.bytes)], file.name));
  const response = await importRoute(
    new NextRequest(`${APP}/api/v1/data/import`, { method: "POST", headers: { origin: APP, "sec-fetch-site": "same-origin", "x-request-id": actorState.requestId }, body: form }),
    undefined as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A restaurant of its own in India, with its owner signed in. */
async function freshRestaurant() {
  const { tenant } = await createTenant(db, { countryCode: "IN" });
  const owner = await createUser(db);
  await createMembership(db, tenant.id, owner.id, "TENANT_ADMIN");
  await asUserId(owner.id);
  return { tenant, owner };
}

const csv = (text: string) => ({ name: "list.csv", bytes: Buffer.from(text, "utf8") });

describe("TC-ADR22-001 a customer list imports from CSV or Excel, checked like the console's own form", () => {
  it("adds new customers, turns local mobiles into +91, skips phones already on file and flags bad rows", async () => {
    const { tenant } = await freshRestaurant();
    await createCustomer(db, tenant.id, { fullName: "Already Here", phoneE164: "+919876500001" });

    const good = csv("Name,Mobile,Email\r\nAsha Rao,98765 00002,asha@example.test\r\nAlready Here,9876500001,\r\nRavi,,\r\n");
    const preview = await importList("customers", good, "preview");
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ total: 3, toCreate: 2, duplicates: 1, errors: [] });

    const commit = await importList("customers", good, "commit");
    expect(commit.body).toMatchObject({ created: 2, duplicates: 1, failed: [] });
    const asha = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id, fullName: "Asha Rao" } });
    expect(asha.phoneE164).toBe("+919876500002");
    expect(await db.auditLog.count({ where: { tenantId: tenant.id, action: "customer.created" } })).toBe(2);

    const bad = await importList("customers", csv("Name,Phone\r\nX,12\r\n"), "preview");
    expect((bad.body.errors as unknown[]).length).toBe(1);
    expect((await importList("customers", csv("Name,Phone\r\nX,12\r\n"), "commit")).status).toBe(422);
  });

  it("reads the first sheet of an Excel workbook", async () => {
    const { tenant } = await freshRestaurant();
    const workbook = toXlsx([{ name: "Guests", columns: ["Customer Name", "Phone Number"], rows: [["Meera", "9123456780"]] }]);
    const commit = await importList("customers", { name: "guests.xlsx", bytes: workbook }, "commit");
    expect(commit.status).toBe(200);
    expect((await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id, fullName: "Meera" } })).phoneE164).toBe("+919123456780");
  });

  it("says which required column is missing", async () => {
    await freshRestaurant();
    const result = await importList("customers", csv("Mobile\r\n9876500003\r\n"), "preview");
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("needs a column for: Name");
  });

  it("only the owner/administrator imports, and only into their own restaurant", async () => {
    await asSeedUser("A", "MANAGER");
    expect((await importList("customers", csv("Name\r\nNope\r\n"), "commit")).status).toBe(403);
    expect(await db.customer.count({ where: { fullName: "Nope" } })).toBe(0);
  });
});

describe("TC-ADR22-002 a menu list creates sections and dishes, never duplicates", () => {
  it("creates missing categories, keeps prices as decimals and skips dishes already in their section", async () => {
    const { tenant } = await freshRestaurant();
    const starters = await createCategory(db, tenant.id, { name: "Starters" });
    await createMenuItem(db, tenant.id, starters.id, { name: "Paneer Tikka" });
    const file = csv("Category,Dish,Price,GST %,Veg\r\nStarters,Paneer Tikka,240,5,veg\r\nStarters,Gobi 65,180.50,5,veg\r\nMain Course,Butter Chicken,₹360,5,non-veg\r\n");

    const preview = await importList("menuItems", file, "preview");
    expect(preview.body).toMatchObject({ toCreate: 2, duplicates: 1, errors: [], newCategories: ["Main Course"] });
    const commit = await importList("menuItems", file, "commit");
    expect(commit.body).toMatchObject({ created: 2, duplicates: 1 });

    const gobi = await db.menuItem.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Gobi 65" } });
    expect(gobi.basePrice.toFixed(2)).toBe("180.50");
    expect(gobi.dietaryType).toBe("VEG");
    const main = await db.menuCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Main Course" } });
    expect((await db.menuItem.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Butter Chicken" } })).categoryId).toBe(main.id);
  });

  it("refuses a list without a tax rate rather than inventing one", async () => {
    await freshRestaurant();
    const result = await importList("menuItems", csv("Category,Name,Price\r\nStarters,Soup,90\r\n"), "preview");
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("Tax rate");
  });
});

describe("TC-ADR22-003 the reports export sums each day exactly", () => {
  it("one row per business date with sales and payments by method, as decimal text", async () => {
    const { tenant, owner } = await freshRestaurant();
    const category = await createCategory(db, tenant.id);
    const item = await createMenuItem(db, tenant.id, category.id, { basePrice: "100.00", taxRate: "5.00" });
    const day = new Date("2026-09-20T00:00:00.000Z");
    const first = await createOrder(db, tenant.id, [{ menuItem: item, quantity: 1 }], { status: "COMPLETED", businessDate: day });
    await createOrder(db, tenant.id, [{ menuItem: item, quantity: 2 }], { status: "COMPLETED", businessDate: day });
    await createOrder(db, tenant.id, [{ menuItem: item, quantity: 9 }], { status: "CANCELLED", businessDate: day });
    await db.transaction.update({ where: { id: (await createPayment(db, tenant.id, first.order.id, owner.id, "105.00", "CASH")).id }, data: { businessDate: day } });

    const response = await exportRoute(
      new NextRequest(`${APP}/api/v1/data/export?datasets=reports&format=json&from=2026-09-20&to=2026-09-20`, { headers: { "sec-fetch-site": "same-origin", "x-request-id": actorState.requestId } }),
      undefined as never,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
    expect(body.reports).toEqual([
      { businessDate: "2026-09-20", orders: 2, subtotal: "300.00", tax: "15.00", discounts: "0.00", sales: "315.00", cash: "105.00", card: "0.00", upi: "0.00", refunds: "0.00" },
    ]);
  });
});

describe("TC-ADR22-004 brand colours and the menu presentation belong to one restaurant", () => {
  let saved: { tenantId: string; brandColors: unknown; menuStyle: string; dailyStyle: string; websitePublished: boolean }[] = [];
  beforeAll(async () => {
    saved = await db.restaurant.findMany({ where: { tenantId: { in: [A, B] } }, select: { tenantId: true, brandColors: true, menuStyle: true, dailyStyle: true, websitePublished: true } });
  });
  afterAll(async () => {
    for (const row of saved) {
      await db.restaurant.updateMany({ where: { tenantId: row.tenantId }, data: { brandColors: row.brandColors as never, menuStyle: row.menuStyle as never, dailyStyle: row.dailyStyle as never, websitePublished: row.websitePublished } });
    }
  });

  it("saves any number of named colours in order, writes #RGB in full, and refuses bad values", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const colours = [
      { name: "Gold", hex: "#F59E0B" },
      { name: "Cream", hex: "#fff" },
      { name: "Deep Green", hex: "#166534" },
      { name: "Plum", hex: "#7E22CE" },
      { name: "Rose", hex: "#BE123C" },
    ];
    const result = await invokeAction(updateWebsiteThemeAction, { preset: "PLATFORM", surfaceMode: "DARK", brandColors: colours, menuStyle: "GRID", dailyStyle: "GRID" });
    expect(result).toMatchObject({ ok: true });
    const stored = await db.restaurant.findUniqueOrThrow({ where: { tenantId: A } });
    expect(stored.brandColors).toEqual([{ name: "Gold", hex: "#F59E0B" }, { name: "Cream", hex: "#FFFFFF" }, { name: "Deep Green", hex: "#166534" }, { name: "Plum", hex: "#7E22CE" }, { name: "Rose", hex: "#BE123C" }]);
    expect(stored).toMatchObject({ menuStyle: "GRID", dailyStyle: "GRID" });
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: B } })).brandColors).toEqual(saved.find((r) => r.tenantId === B)!.brandColors);

    for (const bad of [[{ name: "X", hex: "red" }], [{ name: "", hex: "#000000" }], [{ name: "Same", hex: "#000000" }, { name: "same", hex: "#111111" }]]) {
      expect(await invokeAction(updateWebsiteThemeAction, { preset: "PLATFORM", surfaceMode: "DARK", brandColors: bad })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("the ring setting puts the 3D ring on the site with no card grid repeating the menu; cards style shows the grid", async () => {
    await db.restaurant.updateMany({ where: { tenantId: A }, data: { websitePublished: true } });
    const slug = (await db.tenant.findUniqueOrThrow({ where: { id: A } })).slug;
    const render = async () => {
      asAnonymous();
      const element = await invokeLoader(PublicRestaurantPage, { params: Promise.resolve({ slug }) });
      return renderToStaticMarkup(element as ReactElement);
    };
    await db.restaurant.updateMany({ where: { tenantId: A }, data: { menuStyle: "RING" } });
    const ring = await render();
    expect(ring).toContain('data-testid="menu-ring"');
    expect(ring).not.toMatch(/id="menu-[0-9a-f-]{36}"/);

    await db.restaurant.updateMany({ where: { tenantId: A }, data: { menuStyle: "GRID" } });
    const grid = await render();
    expect(grid).not.toContain('data-testid="menu-ring"');
    expect(grid).toMatch(/id="menu-[0-9a-f-]{36}"/);
  });
});

describe("TC-ADR22-005 print history: finished jobs leave the list, live ones never do", () => {
  it("archives printed and failed jobs, leaves waiting ones, audits it, and cannot reach another restaurant", async () => {
    const printerA = await createPrinter(db, A);
    const finish = async (job: { id: string }, status: "PRINTED" | "FAILED") =>
      db.printJob.update({ where: { id: job.id }, data: status === "PRINTED" ? { status, printedAt: new Date() } : { status, failedAt: new Date(), lastErrorCode: "OFFLINE" } });
    const printed = await finish(await createPrintJob(db, A, printerA.id), "PRINTED");
    const failed = await finish(await createPrintJob(db, A, printerA.id), "FAILED");
    const waiting = await createPrintJob(db, A, printerA.id, { status: "PENDING" });
    const printerB = await createPrinter(db, B);
    const otherTenant = await finish(await createPrintJob(db, B, printerB.id), "PRINTED");

    await asSeedUser("A", "MANAGER");
    const result = await invokeAction(archivePrintJobsAction, { jobIds: [printed.id, failed.id, waiting.id, otherTenant.id] });
    expect(result).toMatchObject({ ok: true, data: { archived: 2 } });
    const after = await db.printJob.findMany({ where: { id: { in: [printed.id, failed.id, waiting.id, otherTenant.id] } }, select: { id: true, archivedAt: true } });
    const archived = new Set(after.filter((j) => j.archivedAt).map((j) => j.id));
    expect(archived).toEqual(new Set([printed.id, failed.id]));
    expect(await db.auditLog.count({ where: { tenantId: A, action: "print_job.archived" } })).toBeGreaterThanOrEqual(1);
    // The database itself refuses to hide a job that is still in the queue.
    await expect(db.printJob.update({ where: { id: waiting.id }, data: { archivedAt: new Date(), archivedByUserId: null } })).rejects.toThrow();
  });

  it.each(["CASHIER", "KITCHEN", "WAITER"] as const)("%s cannot clear print history", async (role) => {
    await asSeedUser("A", role);
    expect(await invokeAction(archivePrintJobsAction, { olderThanDays: 30 })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
