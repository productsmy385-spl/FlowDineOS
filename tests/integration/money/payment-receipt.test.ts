import { beforeAll, describe, expect, it } from "vitest";
import { recordPaymentAction } from "@/app/restaurant/transactions/actions";
import { createCategory, createMembership, createMenuItem, createOrder, createTenant, createUser } from "../../factories";
import { testDb } from "../setup/db";
import { asSeedUser, asUserId, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { key, newOrder, okData } from "./helpers";

/**
 * TC-TXN-020…023 — a settled bill prints its receipt (owner brief 2026-10-06 §15–17).
 *
 * The cashier records the payment; once it settles the bill, the receipt is queued for the restaurant's own receipt
 * printer through the same queue the print agent drains. These tests stop at "queued" on purpose: the agent's report
 * is what marks a job PRINTED, and nothing here may claim more than that.
 */
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

const receiptJobsFor = (orderId: string) => db.printJob.findMany({ where: { tenantId: A, orderId, jobType: "RECEIPT" } });

describe("TC-TXN-020 paying the bill in full queues one receipt", () => {
  it("queues the receipt on the receipt printer, keyed to this payment, and tells the cashier", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A"); // 210.00

    const paid = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "210.00", reference: "SLIP-RCPT-1" }));
    expect(paid.paymentStatus).toBe("PAID");
    expect(paid.receipt).toMatchObject({ status: "QUEUED" });

    const jobs = await receiptJobsFor(order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupeKey: `RECEIPT:PAYMENT:${paid.transactionId}`, status: "PENDING", tenantId: A });
    // Queued, never "printed": only the print agent's confirmation may say that.
    expect(jobs[0].status).not.toBe("PRINTED");
    const printer = await db.printer.findUniqueOrThrow({ where: { id: jobs[0].printerId } });
    expect(["RECEIPT", "KOT_AND_RECEIPT"]).toContain(printer.purpose);

    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: A, action: "print_job.created", resourceId: jobs[0].id } });
    expect(audit.afterState).toMatchObject({ jobType: "RECEIPT", orderId: order.id, trigger: "payment" });
  });

  it("a partial payment prints nothing — the receipt waits until the bill is settled", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A"); // 210.00

    const part = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CASH", amount: "100.00" }));
    expect(part.paymentStatus).toBe("PARTIALLY_PAID");
    expect(part.receipt).toEqual({ status: "NOT_REQUESTED" });
    expect(await receiptJobsFor(order.id)).toHaveLength(0);

    const rest = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CASH", amount: "110.00" }));
    expect(rest.paymentStatus).toBe("PAID");
    expect(rest.receipt).toMatchObject({ status: "QUEUED" });
    expect(await receiptJobsFor(order.id)).toHaveLength(1);
  });
});

describe("TC-TXN-021 clicking 'record payment' twice never prints twice", () => {
  it("the same submit replays the payment and queues nothing more", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const idempotencyKey = key();
    const input = { orderId: order.id, idempotencyKey, method: "CARD" as const, amount: "210.00", reference: "SLIP-RCPT-2" };

    const first = okData(await invokeAction(recordPaymentAction, input));
    const second = okData(await invokeAction(recordPaymentAction, input));
    expect(first.receipt).toMatchObject({ status: "QUEUED" });
    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await receiptJobsFor(order.id)).toHaveLength(1);
  });

  it("a second payment on a settled bill is refused, so it cannot print a second receipt either", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "210.00", reference: "SLIP-RCPT-3" }));
    const again = await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "1.00", reference: "SLIP-RCPT-4" });
    expect(again).toMatchObject({ ok: false, error: { code: "AMOUNT_EXCEEDS_BALANCE" } });
    expect(await receiptJobsFor(order.id)).toHaveLength(1);
  });
});

describe("TC-TXN-022 the payment stands even when the receipt cannot print", () => {
  it("with no receipt printer set up, the payment is recorded and the cashier is told so", async () => {
    // A restaurant of its own, with no printers at all, so nothing shared with other tests is touched.
    const { tenant } = await createTenant(db);
    const admin = await createUser(db);
    await createMembership(db, tenant.id, admin.id, "TENANT_ADMIN");
    const category = await createCategory(db, tenant.id);
    const item = await createMenuItem(db, tenant.id, category.id, { basePrice: "100.00", taxRate: "5.00" });
    const { order } = await createOrder(db, tenant.id, [{ menuItem: item, quantity: 1 }], { status: "READY" });
    await asUserId(admin.id);

    const paid = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "105.00", reference: "SLIP-RCPT-5" }));
    expect(paid.paymentStatus).toBe("PAID");
    expect(paid.receipt).toEqual({ status: "NO_PRINTER" });
    expect(await db.transaction.count({ where: { tenantId: tenant.id, orderId: order.id, type: "PAYMENT" } })).toBe(1);
    expect(await db.printJob.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

describe("TC-TXN-023 a receipt only ever reaches its own restaurant's printer", () => {
  it("the queued job and its printer both belong to the paying tenant", async () => {
    await asSeedUser("A", "CASHIER");
    const order = await newOrder("A");
    const paid = okData(await invokeAction(recordPaymentAction, { orderId: order.id, idempotencyKey: key(), method: "CARD", amount: "210.00", reference: "SLIP-RCPT-6" }));
    const job = await db.printJob.findFirstOrThrow({ where: { dedupeKey: `RECEIPT:PAYMENT:${paid.transactionId}` }, include: { printer: true } });
    expect(job.tenantId).toBe(A);
    expect(job.printer.tenantId).toBe(A);
  });
});
