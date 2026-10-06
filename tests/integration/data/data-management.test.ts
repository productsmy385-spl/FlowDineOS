import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "@/app/api/v1/data/export/route";
import { POST as importRoute } from "@/app/api/v1/data/import/route";
import { purgeDataAction } from "@/app/restaurant/settings/data/actions";
import { unzip } from "@/lib/data-portability/zip";
import { createCustomer, createFullTenant, createMembership, createUser } from "../../factories";
import { testDb } from "../setup/db";
import { actorState } from "../helpers/actor-state";
import { asSeedUser, asUserId, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";

/**
 * TC-DATA-001…010 — backups, restore and date-range deletion (RASOIOS-ADR-021; owner brief 2026-10-06 §3–8, §30).
 *
 * Each test that deletes builds its own restaurant with one row in every table (`createFullTenant`), so nothing is
 * removed from the seeded tenants other suites share.
 */
const db = testDb();
const APP = "http://localhost:3000";
const CONFIRM = "DELETE MY RESTAURANT DATA";

beforeAll(seedOnce, 120_000);

async function exportAs(params: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  const query = new URLSearchParams(params);
  const response = await exportRoute(new NextRequest(`${APP}/api/v1/data/export?${query}`, { headers: { "x-request-id": actorState.requestId, ...headers } }), undefined as never);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString("utf8")) };
}

async function importAs(file: { name: string; bytes: Buffer }, mode: "preview" | "commit") {
  const form = new FormData();
  form.append("mode", mode);
  form.append("file", new File([new Uint8Array(file.bytes)], file.name));
  const response = await importRoute(
    new NextRequest(`${APP}/api/v1/data/import`, { method: "POST", headers: { origin: APP, "sec-fetch-site": "same-origin", "x-request-id": actorState.requestId }, body: form }),
    undefined as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A restaurant of its own, every table filled, its orders finished and dated in early September. */
async function freshRestaurant(label: string) {
  const full = await createFullTenant(db, label);
  await db.order.updateMany({ where: { tenantId: full.tenant.id }, data: { status: "COMPLETED" } });
  await asUserId(full.user.id);
  return full;
}

describe("TC-DATA-001 a full backup holds the restaurant's data and none of its secrets", () => {
  it("downloads a ZIP with backup.json, an Excel workbook and CSV files, and records the export", async () => {
    const full = await freshRestaurant("export");
    const result = await exportAs({ datasets: "restaurant,menu,dailyMenus,customers,orders,transactions,staff,social,printing,audit", format: "zip" });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/zip");
    const backupId = result.headers.get("x-backup-id")!;

    const files = unzip(result.bytes, { maxEntries: 100, maxTotalBytes: 50 * 1024 * 1024 });
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["backup.json", "metadata.json", "README.txt", "csv/orders.csv", "csv/transactions.csv", "csv/staff.csv"]));
    expect(names.some((n) => n.endsWith(".xlsx"))).toBe(true);

    const backup = JSON.parse(files.find((f) => f.name === "backup.json")!.data.toString("utf8"));
    expect(backup.restaurant.tenantId).toBe(full.tenant.id);
    expect(backup.tables.order.map((o: { id: string }) => o.id)).toEqual([full.order.id]);
    // Money leaves as the exact decimal text, never a float.
    expect(backup.tables.transaction.find((t: { id: string }) => t.id === full.payment.id).amount).toBe("10");

    const everything = files.map((f) => f.data.toString("latin1")).join("\n");
    expect(everything).not.toContain("passwordHash");
    expect(everything).not.toContain("tokenHash");
    expect(everything).not.toContain("scrypt$");
    expect(everything).not.toContain(full.staffSession.tokenHash);

    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: full.tenant.id, action: "data.exported" }, orderBy: { createdAt: "desc" } });
    expect(audit.afterState).toMatchObject({ backupId, format: "zip", full: true });
  });

  it("a cell that would run as a spreadsheet formula is neutralised in CSV", async () => {
    const full = await freshRestaurant("csv");
    await createCustomer(db, full.tenant.id, { fullName: '=HYPERLINK("http://x")' });
    const result = await exportAs({ datasets: "customers", format: "csv" });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/csv");
    expect(result.bytes.toString("utf8")).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe("TC-DATA-002 an export never carries another restaurant's records", () => {
  it("Tenant A's export holds no row of Tenant B", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await exportAs({ datasets: "menu,customers,orders,transactions", format: "json" });
    expect(result.status).toBe(200);
    const text = result.bytes.toString("utf8");
    expect(text).toContain(tenantIdOf("A"));
    expect(text).not.toContain(tenantIdOf("B"));
  });
});

describe("TC-DATA-003 only the owner/administrator exports, and only from this app", () => {
  it.each(["MANAGER", "CASHIER", "KITCHEN", "WAITER"] as const)("%s is refused", async (role) => {
    await asSeedUser("A", role);
    expect((await exportAs({ datasets: "orders", format: "json" })).status).toBe(403);
  });

  it("a cross-site request is refused even for the administrator", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await exportAs({ datasets: "orders", format: "json" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("a tenant id in the query is rejected, not used", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    expect((await exportAs({ datasets: "orders", format: "json", tenantId: tenantIdOf("B") })).status).toBe(422);
  });
});

describe("TC-DATA-004 deleting needs a matching backup and the typed confirmation", () => {
  it("is refused without a backup, with a backup that does not cover the data, and without the exact words", async () => {
    const full = await freshRestaurant("guard");
    const input = { categories: ["orders" as const], before: "2026-10-01", backupId: randomUUID(), confirmation: CONFIRM };
    expect(await invokeAction(purgeDataAction, input)).toMatchObject({ ok: false, error: { code: "BACKUP_REQUIRED" } });

    // A backup of the menu does not cover orders.
    const menuOnly = await exportAs({ datasets: "menu", format: "json", backupId: randomUUID() });
    expect(await invokeAction(purgeDataAction, { ...input, backupId: menuOnly.headers.get("x-backup-id")! })).toMatchObject({ ok: false, error: { code: "BACKUP_REQUIRED" } });

    // A backup that stops before the cutoff does not cover it either.
    const short = await exportAs({ datasets: "orders,transactions", format: "json", to: "2026-09-01" });
    expect(await invokeAction(purgeDataAction, { ...input, backupId: short.headers.get("x-backup-id")! })).toMatchObject({ ok: false, error: { code: "BACKUP_REQUIRED" } });

    const good = await exportAs({ datasets: "orders,transactions", format: "zip", to: "2026-09-30" });
    expect(await invokeAction(purgeDataAction, { ...input, backupId: good.headers.get("x-backup-id")!, confirmation: "delete" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    });
    expect(await db.order.count({ where: { tenantId: full.tenant.id } })).toBe(1);
  });

  it("a backup taken by another restaurant cannot authorise this one's deletion", async () => {
    await asSeedUser("B", "TENANT_ADMIN");
    const other = await exportAs({ datasets: "orders,transactions", format: "json" });
    const full = await freshRestaurant("borrowed");
    const outcome = await invokeAction(purgeDataAction, { categories: ["orders"], before: "2026-10-01", backupId: other.headers.get("x-backup-id")!, confirmation: CONFIRM });
    expect(outcome).toMatchObject({ ok: false, error: { code: "BACKUP_REQUIRED" } });
    expect(await db.order.count({ where: { tenantId: full.tenant.id } })).toBe(1);
  });

  it.each(["MANAGER", "CASHIER"] as const)("%s cannot delete at all", async (role) => {
    await asSeedUser("A", role);
    const outcome = await invokeAction(purgeDataAction, { categories: ["orders"], before: "2026-10-01", backupId: randomUUID(), confirmation: CONFIRM });
    expect(outcome).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("TC-DATA-005 delete, then restore from the backup", () => {
  it("removes finished history before the date, keeps open orders, records the deletion — and the backup brings it all back", async () => {
    const full = await freshRestaurant("roundtrip");
    // An open order from the same period must survive.
    const open = await db.order.create({
      data: { ...stripIds(full.order), status: "PREPARING", orderNumber: `OPEN-${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() },
    });
    const before = { orders: await db.order.count({ where: { tenantId: full.tenant.id } }), payments: await db.transaction.count({ where: { tenantId: full.tenant.id } }) };

    const backup = await exportAs({ datasets: "orders,transactions,customers", format: "zip", to: "2026-09-30" });
    expect(backup.status).toBe(200);
    const outcome = await invokeAction(purgeDataAction, { categories: ["orders"], before: "2026-10-01", backupId: backup.headers.get("x-backup-id")!, confirmation: CONFIRM });
    expect(outcome).toMatchObject({ ok: true, data: { deleted: { orders: 1, payments: 2 }, keptOpenOrders: 1 } });

    expect(await db.order.findMany({ where: { tenantId: full.tenant.id }, select: { id: true } })).toEqual([{ id: open.id }]);
    expect(await db.transaction.count({ where: { tenantId: full.tenant.id } })).toBe(0);
    const record = await db.auditLog.findFirstOrThrow({ where: { tenantId: full.tenant.id, action: "data.deleted" } });
    expect(record.afterState).toMatchObject({ categories: ["orders"], before: "2026-10-01" });

    // Restore: the preview counts what comes back; the commit puts it back exactly.
    const file = { name: "backup.zip", bytes: backup.bytes };
    const preview = await importAs(file, "preview");
    expect(preview.status).toBe(200);
    expect(preview.body.canImport).toBe(true);
    const tables = preview.body.tables as { table: string; toAdd: number; alreadyHere: number; invalid: number }[];
    expect(tables.find((t) => t.table === "order")).toMatchObject({ toAdd: 1, invalid: 0 });
    expect(tables.find((t) => t.table === "transaction")).toMatchObject({ toAdd: 2, invalid: 0 });
    expect(tables.find((t) => t.table === "customer")).toMatchObject({ toAdd: 0, alreadyHere: 1 });

    const commit = await importAs(file, "commit");
    expect(commit.status).toBe(200);
    expect(await db.order.count({ where: { tenantId: full.tenant.id } })).toBe(before.orders);
    expect(await db.transaction.count({ where: { tenantId: full.tenant.id } })).toBe(before.payments);
    const restored = await db.order.findUniqueOrThrow({ where: { id: full.order.id } });
    expect(restored.totalAmount.toFixed(2)).toBe(full.order.totalAmount.toFixed(2));
    expect(restored.tenantId).toBe(full.tenant.id);
    expect(await db.auditLog.count({ where: { tenantId: full.tenant.id, action: "data.imported" } })).toBe(1);

    // Importing the same file again adds nothing.
    expect((await importAs(file, "preview")).body.canImport).toBe(false);
  });
});

describe("TC-DATA-006 the audit log loses only this restaurant's old entries, and never the data record", () => {
  it("deletes old entries of this tenant, keeps every data.* entry, and leaves other tenants alone", async () => {
    const full = await freshRestaurant("audit");
    const old = new Date("2026-01-01T00:00:00Z");
    await db.auditLog.create({ data: { tenantId: full.tenant.id, actorType: "SYSTEM", action: "menu_item.updated", resourceType: "menu_item", createdAt: old } });
    await db.auditLog.create({ data: { tenantId: full.tenant.id, actorType: "SYSTEM", action: "data.exported", resourceType: "tenant_data", createdAt: old } });
    const otherOld = await db.auditLog.create({ data: { tenantId: tenantIdOf("B"), actorType: "SYSTEM", action: "menu_item.updated", resourceType: "menu_item", createdAt: old } });

    const backup = await exportAs({ datasets: "audit", format: "json" });
    const outcome = await invokeAction(purgeDataAction, { categories: ["audit"], before: "2026-06-01", backupId: backup.headers.get("x-backup-id")!, confirmation: CONFIRM });
    expect(outcome).toMatchObject({ ok: true, data: { deleted: { auditEntries: 1 } } });

    expect(await db.auditLog.count({ where: { tenantId: full.tenant.id, createdAt: old } })).toBe(1); // the data.exported one
    expect(await db.auditLog.findUnique({ where: { id: otherOld.id } })).not.toBeNull();
  });

  it("outside the deletion service the audit log is still append-only", async () => {
    const row = await db.auditLog.create({ data: { tenantId: tenantIdOf("A"), actorType: "SYSTEM", action: "menu_item.updated", resourceType: "menu_item", createdAt: new Date("2025-01-01T00:00:00Z") } });
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.update({ where: { id: row.id }, data: { reason: "x" } })).rejects.toThrow(/append-only/);
  });
});

describe("TC-DATA-007 a backup cannot move data between restaurants", () => {
  it("a backup of another restaurant is refused", async () => {
    await freshRestaurant("source");
    const backup = await exportAs({ datasets: "menu,orders,transactions", format: "json" });
    await asSeedUser("A", "TENANT_ADMIN");
    const preview = await importAs({ name: "backup.json", bytes: backup.bytes }, "preview");
    expect(preview.status).toBe(422);
    expect(JSON.stringify(preview.body)).toContain("belongs to another restaurant");
  });

  it("a hand-made file without the restaurant block lands only in the importer's restaurant, and cannot link to another's rows", async () => {
    const full = await freshRestaurant("crafted");
    const tenantBItem = await db.menuItem.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    const crafted = {
      format: "rasoios-backup",
      version: 1,
      tables: {
        customer: [{ id: randomUUID(), tenantId: tenantIdOf("B"), fullName: "Planted in B?", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" }],
        orderItem: [
          {
            ...stripDates(await db.orderItem.findFirstOrThrow({ where: { tenantId: full.tenant.id } })),
            id: randomUUID(),
            menuItemId: tenantBItem.id,
          },
        ],
      },
    };
    const preview = await importAs({ name: "crafted.json", bytes: Buffer.from(JSON.stringify(crafted)) }, "preview");
    expect(preview.status).toBe(200);
    expect(preview.body.canImport).toBe(false);
    expect((preview.body.tables as { table: string; invalid: number }[]).find((t) => t.table === "orderItem")).toMatchObject({ invalid: 1 });

    // Without the bad row the customer goes in — into this restaurant, whatever the file said.
    const onlyCustomer = { ...crafted, tables: { customer: crafted.tables.customer } };
    const commit = await importAs({ name: "crafted.json", bytes: Buffer.from(JSON.stringify(onlyCustomer)) }, "commit");
    expect(commit.status).toBe(200);
    const planted = await db.customer.findUniqueOrThrow({ where: { id: crafted.tables.customer[0].id } });
    expect(planted.tenantId).toBe(full.tenant.id);
  });

  it("a row naming a person from outside the restaurant is refused", async () => {
    const full = await freshRestaurant("people");
    const stranger = await createUser(db);
    const other = await createFullTenant(db, "people-other");
    await createMembership(db, other.tenant.id, stranger.id, "MANAGER");
    const crafted = {
      format: "rasoios-backup",
      version: 1,
      tables: { customer: [{ id: randomUUID(), fullName: "Anyone", createdByUserId: stranger.id, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" }] },
    };
    await asUserId(full.user.id);
    const preview = await importAs({ name: "people.json", bytes: Buffer.from(JSON.stringify(crafted)) }, "preview");
    expect(preview.body.canImport).toBe(false);
    expect(JSON.stringify(preview.body.issues)).toContain("not part of this restaurant");
  });

  it("only the owner/administrator may import", async () => {
    await asSeedUser("A", "MANAGER");
    const result = await importAs({ name: "x.json", bytes: Buffer.from("{}") }, "preview");
    expect(result.status).toBe(403);
  });
});

function stripIds<T extends Record<string, unknown>>(row: T) {
  const { id, createdAt, updatedAt, ...rest } = row;
  void id;
  void createdAt;
  void updatedAt;
  return rest as Omit<T, "id" | "createdAt" | "updatedAt">;
}

function stripDates(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" && "toFixed" in v ? (v as { toFixed: () => string }).toFixed() : v]),
  );
}
