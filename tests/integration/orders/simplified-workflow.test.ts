import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPaymentReceiptsAction, getSettlementAction, retryPaymentReceiptsAction, settleOrderAction } from "@/app/restaurant/orders/settle-actions";
import { createStaffOrderAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { updateKOTStatusAction } from "@/app/restaurant/kitchen/actions";
import { getRestaurantSettingsAction, updateOperationalSettingsAction } from "@/app/restaurant/settings/actions";
import { recordPaymentAction } from "@/app/restaurant/transactions/actions";
import { AUTO_READY_TRIGGER } from "@/lib/data/auto-ready";
import { printDocumentSchema } from "@/lib/print/types";
import { AUTO_READY_AFTER_MINUTES, runAutoReadySweep, type SettlementResult } from "@/lib/services/simplified-workflow";
import { asSeedUser, invokeAction, seedOnce, tenantIdOf, type TenantKey } from "../helpers/actors";
import { errorOf, key, newOrder, okData } from "../money/helpers";
import { testDb } from "../setup/db";

/**
 * Simplified order workflow (owner brief 2026-10-13).
 *
 * TC-SOW-001…010 — the per-restaurant switch and the 10-minute automatic READY.
 * TC-SOW-011…018 — Record Payment from the Orders board: payment, completion and receipts.
 *
 * Every test turns the switch back off afterwards, so the seed's restaurants keep the manual workflow for other files.
 */
const db = testDb();
const A = tenantIdOf("A");
const B = tenantIdOf("B");
const MINUTE = 60_000;

beforeAll(seedOnce, 120_000);
afterEach(async () => {
  await db.restaurant.updateMany({ where: { tenantId: { in: [A, B] } }, data: { simplifiedWorkflow: false } });
});

const setWorkflow = (tenantId: string, on: boolean) => db.restaurant.update({ where: { tenantId }, data: { simplifiedWorkflow: on } });

/** A real staff order sent to the kitchen (ACCEPTED, with its KOTs), accepted `minutesAgo` minutes ago. */
async function acceptedOrder(tenant: TenantKey, minutesAgo: number): Promise<string> {
  await asSeedUser(tenant, "CASHIER");
  // Any orderable item of that tenant's own menu (the seeds differ between A and B).
  const item = await db.menuItem.findFirstOrThrow({
    where: { tenantId: tenantIdOf(tenant), isPublished: true, isAvailable: true, archivedAt: null, variants: { none: {} } },
    select: { id: true },
  });
  const placed = okData(
    await invokeAction(createStaffOrderAction, {
      idempotencyKey: randomUUID(),
      orderType: "TAKEAWAY",
      sendToKitchen: true,
      items: [{ menuItemId: item.id, quantity: 1 }],
    } as never),
  ) as { order: { id: string; status: string } };
  expect(placed.order.status).toBe("ACCEPTED");
  await db.order.update({ where: { id: placed.order.id }, data: { acceptedAt: new Date(Date.now() - minutesAgo * MINUTE) } });
  return placed.order.id;
}

const statusOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;
const timerAudits = (orderId: string) =>
  // The kitchen-derived transitions are SYSTEM-audited too; only the timer's carry its trigger.
  db.auditLog.findMany({
    where: { resourceType: "order", resourceId: orderId, action: "order.status_changed", actorType: "SYSTEM", afterState: { path: ["trigger"], equals: AUTO_READY_TRIGGER } },
  });

// ─── The switch ───

describe("TC-SOW-001 the switch is a persistent, per-restaurant setting only administrators change", () => {
  it("defaults to off, saves for the caller's restaurant only, is audited, and survives a reload", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const before = okData(await invokeAction(getRestaurantSettingsAction)) as { restaurant: Record<string, unknown> };
    expect(before.restaurant.simplifiedWorkflow).toBe(false);
    const r = before.restaurant as Record<string, string | boolean | null>;

    okData(
      await invokeAction(updateOperationalSettingsAction, {
        timezone: r.timezone as string,
        currencyCode: r.currencyCode as string,
        countryCode: r.countryCode as string,
        defaultOrderType: r.defaultOrderType as "DINE_IN",
        autoPrintKot: r.autoPrintKot as boolean,
        simplifiedWorkflow: true,
        receiptFooter: (r.receiptFooter as string | null) ?? "",
        gstin: (r.gstin as string | null) ?? "",
      }),
    );

    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: A } })).simplifiedWorkflow).toBe(true);
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: B } })).simplifiedWorkflow).toBe(false);
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: A, action: "restaurant.settings_updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.afterState).toMatchObject({ simplifiedWorkflow: true });

    // A save that does not send the field (an older form) keeps the stored value.
    okData(
      await invokeAction(updateOperationalSettingsAction, {
        timezone: r.timezone as string,
        currencyCode: r.currencyCode as string,
        countryCode: r.countryCode as string,
        defaultOrderType: r.defaultOrderType as "DINE_IN",
        autoPrintKot: r.autoPrintKot as boolean,
        receiptFooter: (r.receiptFooter as string | null) ?? "",
        gstin: (r.gstin as string | null) ?? "",
      }),
    );
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: A } })).simplifiedWorkflow).toBe(true);
  });

  it("a cashier cannot change it", async () => {
    await asSeedUser("A", "CASHIER");
    const refused = await invokeAction(updateOperationalSettingsAction, { rbacProbe: true } as never);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: A } })).simplifiedWorkflow).toBe(false);
  });

  it("a tenantId in the body is refused, so one restaurant can never switch another's", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const refused = await invokeAction(updateOperationalSettingsAction, { tenantId: B, simplifiedWorkflow: true } as never);
    expect(errorOf(refused).code).toBe("VALIDATION_ERROR");
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: B } })).simplifiedWorkflow).toBe(false);
  });
});

// ─── The timer ───

describe("TC-SOW-002 switch OFF keeps the manual workflow exactly", () => {
  it("an order accepted long ago stays ACCEPTED and its tickets stay QUEUED", async () => {
    const orderId = await acceptedOrder("A", 60);
    await runAutoReadySweep();
    expect(await statusOf(orderId)).toBe("ACCEPTED");
    const tickets = await db.kotTicket.findMany({ where: { tenantId: A, orderId } });
    expect(tickets.every((t) => t.status === "QUEUED")).toBe(true);
    expect(await timerAudits(orderId)).toHaveLength(0);
  });
});

describe("TC-SOW-003 nothing changes before the 10-minute deadline", () => {
  it("an order accepted 9 minutes ago is left alone", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", AUTO_READY_AFTER_MINUTES - 1);
    await runAutoReadySweep();
    expect(await statusOf(orderId)).toBe("ACCEPTED");
  });
});

describe("TC-SOW-004 after 10 minutes an accepted order becomes READY — no browser involved", () => {
  it("advances the order and its tickets in one audited step, timed from acceptance", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", AUTO_READY_AFTER_MINUTES + 1);
    const before = await db.order.findUniqueOrThrow({ where: { id: orderId } });

    // The sweep is a plain server function: nothing here renders a page or opens a dashboard.
    const result = await runAutoReadySweep();
    expect(result.advanced).toBeGreaterThanOrEqual(1);

    const after = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe("READY");
    expect(after.readyAt).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
    // Not paid, not completed: the timer only says "ready".
    expect(after.paymentStatus).toBe("UNPAID");
    expect(after.completedAt).toBeNull();

    const tickets = await db.kotTicket.findMany({ where: { tenantId: A, orderId } });
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.status === "READY" && t.readyAt !== null)).toBe(true);

    const audits = await timerAudits(orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorType: "SYSTEM" });
    expect(audits[0].afterState).toMatchObject({ status: "READY", trigger: AUTO_READY_TRIGGER });
  });

  it("a ticket the chef already started is finished forward, never moved back", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", AUTO_READY_AFTER_MINUTES + 2);
    const ticket = await db.kotTicket.findFirstOrThrow({ where: { tenantId: A, orderId } });
    await asSeedUser("A", "KITCHEN");
    okData(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "PREPARING" }));
    expect(await statusOf(orderId)).toBe("PREPARING");

    await runAutoReadySweep();
    expect(await statusOf(orderId)).toBe("READY");
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("READY");
  });
});

describe("TC-SOW-005 READY, COMPLETED and CANCELLED orders are never touched", () => {
  it("leaves each exactly as it was", async () => {
    await setWorkflow(A, true);
    const ready = await acceptedOrder("A", 30);
    const completed = await acceptedOrder("A", 30);
    const cancelled = await acceptedOrder("A", 30);
    await db.order.update({ where: { id: ready }, data: { status: "READY", readyAt: new Date() } });
    await db.order.update({ where: { id: completed }, data: { status: "COMPLETED", completedAt: new Date() } });
    await asSeedUser("A", "MANAGER");
    okData(await invokeAction(updateOrderStatusAction, { orderId: cancelled, status: "CANCELLED", reason: "Customer left" }));

    const versions = Object.fromEntries(
      await Promise.all([ready, completed, cancelled].map(async (id) => [id, (await db.order.findUniqueOrThrow({ where: { id } })).version])),
    );
    await runAutoReadySweep();

    for (const [id, status] of [[ready, "READY"], [completed, "COMPLETED"], [cancelled, "CANCELLED"]] as const) {
      const row = await db.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(status);
      expect(row.version).toBe(versions[id]);
      expect(await timerAudits(id)).toHaveLength(0);
    }
  });
});

describe("TC-SOW-006 manual kitchen transitions still work with the switch on", () => {
  it("the chef can still take a ticket to PREPARING and READY before the timer", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", 1);
    const tickets = await db.kotTicket.findMany({ where: { tenantId: A, orderId } });
    await asSeedUser("A", "KITCHEN");
    for (const ticket of tickets) {
      okData(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "PREPARING" }));
      okData(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "READY" }));
    }
    expect(await statusOf(orderId)).toBe("READY");
    await runAutoReadySweep();
    expect(await timerAudits(orderId)).toHaveLength(0);
  });
});

describe("TC-SOW-007 concurrent workers advance an order exactly once", () => {
  it("five sweeps at the same instant produce one transition and one audit row", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", 20);
    const before = await db.order.findUniqueOrThrow({ where: { id: orderId } });

    await Promise.all(Array.from({ length: 5 }, () => runAutoReadySweep()));

    const after = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe("READY");
    expect(after.version).toBe(before.version + 1);
    expect(await timerAudits(orderId)).toHaveLength(1);
  });
});

describe("TC-SOW-008 each restaurant's switch is independent", () => {
  it("A on and B off: only A's due order advances", async () => {
    await setWorkflow(A, true);
    const inA = await acceptedOrder("A", 15);
    const inB = await acceptedOrder("B", 15);
    await runAutoReadySweep();
    expect(await statusOf(inA)).toBe("READY");
    expect(await statusOf(inB)).toBe("ACCEPTED");
  });

  it("switching off before the sweep stops it, even for an order already due", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", 15);
    await setWorkflow(A, false);
    await runAutoReadySweep();
    expect(await statusOf(orderId)).toBe("ACCEPTED");
  });
});

// ─── Record Payment from the board ───

const settle = (orderId: string, extra: Record<string, unknown> = {}, idempotencyKey = key()) =>
  invokeAction(settleOrderAction, { orderId, idempotencyKey, method: "CARD", amount: "210.00", reference: "SLIP-SOW-1", ...extra } as never);

const receiptJobs = (tenantId: string, orderId: string) =>
  db.printJob.findMany({ where: { tenantId, orderId, jobType: "RECEIPT" }, orderBy: { copyIndex: "asc" } });

describe("TC-SOW-011 Record Payment on the board is part of the simplified workflow only", () => {
  it("with the switch off it is refused and nothing is recorded; the order page's payment still works", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    expect(errorOf(await settle(order.id)).code).toBe("WORKFLOW_DISABLED");
    expect(errorOf(await invokeAction(getSettlementAction, { orderId: order.id })).code).toBe("WORKFLOW_DISABLED");
    expect(await db.transaction.count({ where: { tenantId: A, orderId: order.id } })).toBe(0);

    // The existing payment path is unchanged.
    const paid = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "210.00", reference: "SLIP-SOW-OFF" }));
    expect(paid.paymentStatus).toBe("PAID");
    expect(await statusOf(order.id)).toBe("READY"); // the manual flow completes by hand
  });
});

describe("TC-SOW-012 paying a READY order records, completes and queues labelled receipts", () => {
  it("one confirm does all three, and says only what the queue knows", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A"); // READY, 210.00

    const view = okData(await invokeAction(getSettlementAction, { orderId: order.id })) as { balanceDue: string; completesOnPayment: boolean };
    expect(view).toMatchObject({ balanceDue: "210.00", completesOnPayment: true });

    const result = okData(await settle(order.id)) as SettlementResult;
    expect(result.payment.paymentStatus).toBe("PAID");
    expect(result.completion).toBe("COMPLETED");
    expect(await statusOf(order.id)).toBe("COMPLETED");

    const jobs = await receiptJobs(A, order.id);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(result.receipts.map((r) => r.printJobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    // Queued is not printed: no copy is reported delivered before the agent says so.
    expect(result.receipts.every((r) => r.status === "QUEUED")).toBe(true);
    if (jobs.length === 2) expect(jobs.map((j) => j.copyLabel)).toEqual(["CUSTOMER COPY", "RESTAURANT COPY"]);
    expect(jobs.every((j) => j.dedupeKey.startsWith(`RECEIPT:PAYMENT:${result.payment.transactionId}`))).toBe(true);
  });

  it("an order still in the kitchen is paid but not completed", async () => {
    await setWorkflow(A, true);
    const orderId = await acceptedOrder("A", 1);
    const total = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalAmount.toFixed(2);
    await asSeedUser("A", "CASHIER");
    const result = okData(await settle(orderId, { amount: total })) as SettlementResult;
    expect(result.payment.paymentStatus).toBe("PAID");
    expect(result.completion).toBe("NOT_READY");
    expect(await statusOf(orderId)).toBe("ACCEPTED");
  });

  it("a part payment leaves the order open and prints nothing yet", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const result = okData(await settle(order.id, { method: "CASH", amount: "100.00", reference: undefined })) as SettlementResult;
    expect(result.payment.paymentStatus).toBe("PARTIALLY_PAID");
    expect(result.completion).toBe("NOT_PAID");
    expect(result.receipts).toHaveLength(0);
    expect(await statusOf(order.id)).toBe("READY");
  });
});

describe("TC-SOW-013 a double click or a refresh never pays or prints twice", () => {
  it("the same submit replays: one ledger row, the same receipt jobs, still completed", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const idempotencyKey = key();

    const [first, second] = await Promise.all([settle(order.id, {}, idempotencyKey), settle(order.id, {}, idempotencyKey)]);
    const a = okData(first) as SettlementResult;
    const b = okData(second) as SettlementResult;
    expect(b.payment.transactionId).toBe(a.payment.transactionId);
    expect(await db.transaction.count({ where: { tenantId: A, orderId: order.id } })).toBe(1);
    const jobs = await receiptJobs(A, order.id);
    expect(new Set(jobs.map((j) => j.dedupeKey)).size).toBe(jobs.length);
    expect(jobs.length).toBe(a.receipts.length || b.receipts.length);

    const third = okData(await settle(order.id, {}, idempotencyKey)) as SettlementResult;
    expect(third.payment.replayed).toBe(true);
    expect(await receiptJobs(A, order.id)).toHaveLength(jobs.length);
    expect(await statusOf(order.id)).toBe("COMPLETED");
  });
});

describe("TC-SOW-014 payment details are validated", () => {
  it("refuses a bad phone, a one-letter name, an amount over the balance and a missing UPI reference", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");

    expect(errorOf(await settle(order.id, { customer: { name: "Ravi", phone: "12345" } })).fieldErrors).toHaveProperty(["customer.phone"]);
    expect(errorOf(await settle(order.id, { customer: { name: "R", phone: "" } })).fieldErrors).toHaveProperty(["customer.name"]);
    expect(errorOf(await settle(order.id, { amount: "999.00" })).code).toBe("AMOUNT_EXCEEDS_BALANCE");
    expect(errorOf(await settle(order.id, { method: "UPI", reference: undefined })).fieldErrors).toHaveProperty("reference");
    expect(await db.transaction.count({ where: { tenantId: A, orderId: order.id } })).toBe(0);
  });
});

describe("TC-SOW-015 customer details", () => {
  it("adds a new customer to an order that has none", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const result = okData(await settle(order.id, { customer: { name: "Asha Rao", phone } })) as SettlementResult;
    expect(result.customer).toBe("CREATED");
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: true } });
    expect(row.customer).toMatchObject({ tenantId: A, fullName: "Asha Rao", phoneE164: phone });
  });

  it("never replaces or edits the customer already on the order", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const existing = await db.customer.create({ data: { tenantId: A, fullName: "Original Name", phoneE164: `+9197${String(Date.now()).slice(-8)}` } });
    await db.order.update({ where: { id: order.id }, data: { customerId: existing.id } });

    const result = okData(await settle(order.id, { customer: { name: "Someone Else", phone: "+919000000001" } })) as SettlementResult;
    expect(result.customer).toBe("KEPT");
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.customerId).toBe(existing.id);
    expect((await db.customer.findUniqueOrThrow({ where: { id: existing.id } })).fullName).toBe("Original Name");
  });
});

describe("TC-SOW-016 a printing failure never reverses or repeats the payment", () => {
  it("retry requeues the same failed copies — no new jobs, no new payment", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const result = okData(await settle(order.id)) as SettlementResult;
    const jobs = await receiptJobs(A, order.id);
    expect(jobs.length).toBeGreaterThan(0);

    await db.printJob.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { status: "FAILED", failedAt: new Date(), lastErrorCode: "PRINTER_OFFLINE", lastErrorMessage: "Printer offline" } });
    const failed = okData(await invokeAction(getPaymentReceiptsAction, { orderId: order.id, transactionId: result.payment.transactionId })) as SettlementResult["receipts"];
    expect(failed.every((r) => r.status === "FAILED")).toBe(true);
    // The payment is untouched by the failure.
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("PAID");

    const retried = okData(await invokeAction(retryPaymentReceiptsAction, { orderId: order.id, transactionId: result.payment.transactionId })) as SettlementResult["receipts"];
    expect(retried.map((r) => r.printJobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(retried.every((r) => r.status === "QUEUED")).toBe(true);

    // Pressing retry again while they are queued changes nothing.
    okData(await invokeAction(retryPaymentReceiptsAction, { orderId: order.id, transactionId: result.payment.transactionId }));
    expect(await receiptJobs(A, order.id)).toHaveLength(jobs.length);
    expect(await db.transaction.count({ where: { tenantId: A, orderId: order.id } })).toBe(1);
  });
});

describe("TC-SOW-017 receipt payloads stay compatible with the installed print agent", () => {
  it("every queued copy is a strict v1 document without the copy metadata older agents reject", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    okData(await settle(order.id));
    for (const job of await receiptJobs(A, order.id)) {
      expect(printDocumentSchema.safeParse(job.payload).success).toBe(true);
      expect(Object.keys(job.payload as object).sort()).toEqual(["blocks", "version", "widthMm"]);
    }
  });
});

describe("TC-SOW-018 tenant isolation for orders, payments and print jobs", () => {
  it("B cannot open, pay, read or retry A's order — the same NOT_FOUND / empty answer as an unknown id", async () => {
    await setWorkflow(A, true);
    await setWorkflow(B, true);
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const paid = okData(await settle(order.id)) as SettlementResult;

    await asSeedUser("B", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(getSettlementAction, { orderId: order.id })).code).toBe("NOT_FOUND");
    expect(errorOf(await settle(order.id, {}, key())).code).toBe("NOT_FOUND");
    expect(okData(await invokeAction(getPaymentReceiptsAction, { orderId: order.id, transactionId: paid.payment.transactionId }))).toEqual([]);
    const retry = await invokeAction(retryPaymentReceiptsAction, { orderId: order.id, transactionId: paid.payment.transactionId });
    expect(errorOf(retry).code).toBe("NOT_FOUND");
    expect(await db.transaction.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.printJob.count({ where: { tenantId: B, orderId: order.id } })).toBe(0);

    // A tenantId smuggled into the body is refused outright.
    expect(errorOf(await settle(order.id, { tenantId: A }, key())).code).toBe("VALIDATION_ERROR");
  });

  it("the kitchen role cannot record payments from the board", async () => {
    await setWorkflow(A, true);
    await asSeedUser("A", "KITCHEN");
    const order = await newOrder("A");
    expect(errorOf(await settle(order.id)).code).toBe("FORBIDDEN");
  });
});
