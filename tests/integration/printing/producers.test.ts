import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createStaffOrderAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { createTestPrintJobAction, printReceiptAction, reprintKotAction } from "@/app/restaurant/printing/actions";
import { parsePrintDocument } from "@/lib/print/types";
import { asSeedUser, invokeAction, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { dataOf, errorOf, testPrinter } from "./helpers";

/**
 * TC-PRINT-001 / TC-KOT-005 / TC-PRINT-012 / TC-PRINT-014 — job producers (S1-P16-T003, architecture.md §6.2).
 *
 * The seeded Tenant A has a KOT printer for the MAIN station, one for TANDOOR and a RECEIPT-only counter printer. The
 * BAR station has no printer at all, which is exactly the "no printer configured" case the routing rules describe.
 */
const db = testDb();
const A = tenantIdOf("A");
const ITEM = { chai: seeded("A", "item:masala-chai"), chicken65: seeded("A", "item:chicken-65"), omelette: seeded("A", "item:masala-omelette") };
const KITCHEN_PRINTER = seeded("A", "printer:kitchen");
const COUNTER_PRINTER = seeded("A", "printer:counter");

beforeAll(seedOnce, 120_000);

async function twoSectionOrder(): Promise<string> {
  await asSeedUser("A", "CASHIER");
  const result = await invokeAction(createStaffOrderAction, {
    idempotencyKey: randomUUID(),
    orderType: "DINE_IN",
    tableLabel: "T4",
    items: [
      { menuItemId: ITEM.chai, quantity: 2, specialInstructions: "Less sugar" },
      { menuItemId: ITEM.chicken65, quantity: 1 },
    ],
  } as never);
  return dataOf(result).order.id;
}

async function accept(orderId: string) {
  await asSeedUser("A", "CASHIER");
  return invokeAction(updateOrderStatusAction, { orderId, status: "ACCEPTED" });
}

async function jobsOfOrder(orderId: string) {
  const kots = await db.kotTicket.findMany({ where: { orderId }, include: { kitchenSection: true } });
  const jobs = await db.printJob.findMany({ where: { tenantId: A, kotTicketId: { in: kots.map((k) => k.id) } }, include: { printer: true } });
  return { kots, jobs };
}

describe("TC-PRINT-001 KOT jobs on acceptance", () => {
  it("queues one job per section to the section's printer, and none for a station without one", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { kots, jobs } = await jobsOfOrder(orderId);

    expect(kots).toHaveLength(2);
    const bar = kots.find((k) => k.kitchenSection?.code === "BAR")!;
    const main = kots.find((k) => k.kitchenSection?.code === "MAIN")!;
    expect(jobs.map((j) => j.kotTicketId)).toEqual([main.id]);

    const job = jobs[0];
    expect(job).toMatchObject({ tenantId: A, printerId: KITCHEN_PRINTER, jobType: "KOT", status: "PENDING", isReprint: false, attemptCount: 0 });
    expect(job.dedupeKey).toBe(`KOT:${main.id}:v1`);
    expect(await db.printJob.count({ where: { kotTicketId: bar.id } })).toBe(0);
  });

  it("commits the job in the acceptance transaction, so ticket and job share one xmin", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { jobs } = await jobsOfOrder(orderId);
    const [ticketXmin] = await db.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM kot_tickets WHERE id = ${jobs[0].kotTicketId}::uuid`;
    const [jobXmin] = await db.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM print_jobs WHERE id = ${jobs[0].id}::uuid`;
    expect(jobXmin.xmin).toBe(ticketXmin.xmin);
  });

  it("renders the kitchen projection: the ticket number and items, never money or a customer", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { kots, jobs } = await jobsOfOrder(orderId);
    const main = kots.find((k) => k.kitchenSection?.code === "MAIN")!;

    const document = parsePrintDocument(jobs[0].payload);
    const serialised = JSON.stringify(document);
    expect(document.widthMm).toBe(80);
    expect(serialised).toContain(main.kotNumber);
    expect(serialised).toContain("Chicken 65");
    expect(serialised).toContain("Main Kitchen");
    expect(serialised).not.toContain("INR");
    expect(serialised).not.toMatch(/\b\d+\.\d{2}\b/);
  });

  it("falls back to an unsectioned KOT printer when the station has none", async () => {
    const fallback = await testPrinter("A", { purpose: "KOT", kitchenSectionId: null, name: "Fallback KOT" });
    try {
      const orderId = await twoSectionOrder();
      dataOf(await accept(orderId));
      const { kots, jobs } = await jobsOfOrder(orderId);
      const bar = kots.find((k) => k.kitchenSection?.code === "BAR")!;
      const main = kots.find((k) => k.kitchenSection?.code === "MAIN")!;

      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.kotTicketId === bar.id)!.printerId).toBe(fallback.id);
      // The station that has its own printer still uses it, not the fallback.
      expect(jobs.find((j) => j.kotTicketId === main.id)!.printerId).toBe(KITCHEN_PRINTER);
    } finally {
      await db.printJob.deleteMany({ where: { printerId: fallback.id } });
      await db.printer.delete({ where: { id: fallback.id } });
    }
  });

  it("creates nothing when every KOT printer is inactive, and the ticket still exists", async () => {
    await db.printer.updateMany({ where: { tenantId: A, purpose: { in: ["KOT", "KOT_AND_RECEIPT"] } }, data: { isActive: false } });
    try {
      const orderId = await twoSectionOrder();
      dataOf(await accept(orderId));
      const { kots, jobs } = await jobsOfOrder(orderId);
      expect(kots).toHaveLength(2);
      expect(jobs).toEqual([]);
    } finally {
      await db.printer.updateMany({ where: { tenantId: A, purpose: { in: ["KOT", "KOT_AND_RECEIPT"] } }, data: { isActive: true } });
    }
  });

  it("creates nothing when the restaurant has auto-print off, and the order is still accepted", async () => {
    await db.restaurant.update({ where: { tenantId: A }, data: { autoPrintKot: false } });
    try {
      const orderId = await twoSectionOrder();
      dataOf(await accept(orderId));
      const { kots, jobs } = await jobsOfOrder(orderId);
      expect(kots).toHaveLength(2);
      expect(jobs).toEqual([]);
      expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("ACCEPTED");
    } finally {
      await db.restaurant.update({ where: { tenantId: A }, data: { autoPrintKot: true } });
    }
  });

  it("a repeated acceptance does not queue the ticket twice (dedupe key)", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    dataOf(await accept(orderId));
    const { jobs } = await jobsOfOrder(orderId);
    expect(jobs).toHaveLength(1);
  });
});

describe("TC-KOT-005 reprint (SA-KOT-02)", () => {
  it("creates a new is_reprint job with an incremented suffix and leaves the ticket's print status alone", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { kots } = await jobsOfOrder(orderId);
    const main = kots.find((k) => k.kitchenSection?.code === "MAIN")!;

    await asSeedUser("A", "MANAGER");
    const first = dataOf(await invokeAction(reprintKotAction, { kotId: main.id }));
    const second = dataOf(await invokeAction(reprintKotAction, { kotId: main.id }));

    expect(first).toMatchObject({ jobType: "KOT", isReprint: true, status: "PENDING" });
    expect(second.id).not.toBe(first.id);
    const rows = await db.printJob.findMany({ where: { kotTicketId: main.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.dedupeKey)).toEqual([`KOT:${main.id}:v1`, `KOT:${main.id}:reprint:1`, `KOT:${main.id}:reprint:2`]);
    expect(JSON.stringify(rows[1].payload)).toContain("REPRINT");

    // The board reads the newest non-reprint job, so reprints never change what the kitchen sees.
    const original = rows.find((r) => !r.isReprint)!;
    expect(original.status).toBe("PENDING");

    const audits = await db.auditLog.findMany({ where: { action: "kot.reprint_requested", resourceId: main.id } });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ tenantId: A, actorRole: "MANAGER" });
  });

  it("returns NO_PRINTER_CONFIGURED for a station with no printer", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { kots } = await jobsOfOrder(orderId);
    const bar = kots.find((k) => k.kitchenSection?.code === "BAR")!;

    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(reprintKotAction, { kotId: bar.id })).code).toBe("NO_PRINTER_CONFIGURED");
    expect(await db.printJob.count({ where: { kotTicketId: bar.id } })).toBe(0);
  });

  it("TC-RBAC WAITER has no kot:reprint and gets FORBIDDEN; a Tenant B ticket is NOT_FOUND", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));
    const { kots } = await jobsOfOrder(orderId);
    const main = kots.find((k) => k.kitchenSection?.code === "MAIN")!;

    await asSeedUser("A", "WAITER");
    expect(await invokeAction(reprintKotAction, { kotId: main.id })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const bKot = await db.kotTicket.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    const before = await db.printJob.count({ where: { kotTicketId: bKot.id } });
    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(reprintKotAction, { kotId: bKot.id })).code).toBe("NOT_FOUND");
    expect(await db.printJob.count({ where: { kotTicketId: bKot.id } })).toBe(before);
    expect(await db.printJob.count({ where: { kotTicketId: bKot.id, isReprint: true } })).toBe(0);
  });
});

describe("TC-PRINT-014 receipt jobs (SA-PRN-06)", () => {
  it("targets a RECEIPT-capable printer with the rendered receipt and an incrementing version", async () => {
    const orderId = await twoSectionOrder();
    dataOf(await accept(orderId));

    await asSeedUser("A", "MANAGER");
    const job = dataOf(await invokeAction(printReceiptAction, { orderId }));
    expect(job).toMatchObject({ jobType: "RECEIPT", status: "PENDING", printer: { id: COUNTER_PRINTER } });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.dedupeKey).toBe(`RECEIPT:${orderId}:v1`);
    const document = parsePrintDocument(row.payload);
    const serialised = JSON.stringify(document);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(serialised).toContain(order.orderNumber);
    expect(serialised).toContain("INR");
    expect(serialised).toContain("TOTAL");

    const again = dataOf(await invokeAction(printReceiptAction, { orderId }));
    expect((await db.printJob.findUniqueOrThrow({ where: { id: again.id } })).dedupeKey).toBe(`RECEIPT:${orderId}:v2`);
    expect(await db.auditLog.count({ where: { action: "print_job.created", resourceId: job.id } })).toBe(1);
  });

  it("returns NO_PRINTER_CONFIGURED when no receipt printer is active", async () => {
    const orderId = await twoSectionOrder();
    await db.printer.updateMany({ where: { tenantId: A, purpose: { in: ["RECEIPT", "KOT_AND_RECEIPT"] } }, data: { isActive: false } });
    try {
      await asSeedUser("A", "MANAGER");
      expect(errorOf(await invokeAction(printReceiptAction, { orderId })).code).toBe("NO_PRINTER_CONFIGURED");
    } finally {
      await db.printer.updateMany({ where: { tenantId: A, purpose: { in: ["RECEIPT", "KOT_AND_RECEIPT"] } }, data: { isActive: true } });
    }
  });

  it("KITCHEN lacks transaction:read and is FORBIDDEN; another tenant's order is NOT_FOUND", async () => {
    const orderId = await twoSectionOrder();
    await asSeedUser("A", "KITCHEN");
    expect(await invokeAction(printReceiptAction, { orderId })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const bOrder = await db.order.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(printReceiptAction, { orderId: bOrder.id })).code).toBe("NOT_FOUND");
  });
});

describe("TC-PRINT-012 test print (SA-PRN-04)", () => {
  it("queues a server-built TEST document and is rate limited to 6 per minute per printer", async () => {
    const printer = await testPrinter("A", { name: "Rate limit printer" });
    await asSeedUser("A", "MANAGER");

    const first = dataOf(await invokeAction(createTestPrintJobAction, { printerId: printer.id }));
    expect(first).toMatchObject({ jobType: "TEST", status: "PENDING", printer: { id: printer.id } });
    const document = parsePrintDocument((await db.printJob.findUniqueOrThrow({ where: { id: first.id } })).payload);
    expect(JSON.stringify(document)).toContain("PRINTER TEST");
    expect(JSON.stringify(document)).toContain("Rate limit printer");

    for (let i = 0; i < 5; i++) dataOf(await invokeAction(createTestPrintJobAction, { printerId: printer.id }));
    const seventh = await invokeAction(createTestPrintJobAction, { printerId: printer.id });
    expect(seventh).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await db.printJob.count({ where: { printerId: printer.id } })).toBe(6);

    // The budget is per printer: another printer is unaffected.
    const other = await testPrinter("A", { name: "Second printer" });
    expect(await invokeAction(createTestPrintJobAction, { printerId: other.id })).toMatchObject({ ok: true });
  });
});
