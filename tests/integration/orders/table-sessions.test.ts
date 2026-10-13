import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStaffOrderAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { settleOrderAction } from "@/app/restaurant/orders/settle-actions";
import {
  closeTableBillAction,
  getTableBillAction,
  getTableBillReceiptsAction,
  listOpenTableBillsAction,
  lookupTableBillAction,
  payTableBillAction,
  retryTableBillReceiptsAction,
} from "@/app/restaurant/orders/table-actions";
import { getKOTTicketsAction, updateKOTStatusAction } from "@/app/restaurant/kitchen/actions";
import { recordPaymentAction } from "@/app/restaurant/transactions/actions";
import { printDocumentSchema } from "@/lib/print/types";
import type { TableBillSettlement, TableBillView } from "@/lib/services/table-sessions";
import { GET as kitchenTicketsRoute } from "@/app/api/v1/kitchen/tickets/route";
import { asSeedUser, invokeAction, invokeRoute, seedOnce, seeded, tenantIdOf, type TenantKey } from "../helpers/actors";
import { errorOf, key, okData } from "../money/helpers";
import { testDb } from "../setup/db";

/**
 * Table bills, consolidated billing and the KOT print choice (RASOIOS-ADR-027).
 *
 * TC-TBL-001…008 sessions · 009…015 billing · 016…022 KOT printing · 023…027 receipts · 028…032 regression.
 * Every test uses its own table label, so tests never share a bill.
 */
const db = testDb();
const A = tenantIdOf("A");
const B = tenantIdOf("B");
const CHICKEN = seeded("A", "item:chicken-65"); // MAIN section — has the kitchen printer
const CHAI = seeded("A", "item:masala-chai"); // BAR section — no printer

beforeAll(seedOnce, 120_000);
afterEach(async () => {
  await db.restaurant.updateMany({ where: { tenantId: { in: [A, B] } }, data: { simplifiedWorkflow: false } });
});

let tableSeq = 0;
const newTable = () => `TB ${process.pid % 1000}-${++tableSeq}-${Math.floor(Math.random() * 900 + 100)}`.slice(0, 20);

type Line = { menuItemId: string; quantity: number };
type PlaceOptions = { expected?: string | null; printKot?: boolean; sendToKitchen?: boolean; idempotencyKey?: string; orderType?: "DINE_IN" | "TAKEAWAY" | "DELIVERY" };

async function place(tenant: TenantKey, tableLabel: string | null, items: Line[], options: PlaceOptions = {}) {
  await asSeedUser(tenant, "CASHIER");
  return invokeAction(createStaffOrderAction, {
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    orderType: options.orderType ?? "DINE_IN",
    ...(tableLabel ? { tableLabel } : {}),
    sendToKitchen: options.sendToKitchen ?? true,
    ...(options.printKot === undefined ? {} : { printKot: options.printKot }),
    ...(options.expected === undefined ? {} : { expectedTableSessionId: options.expected }),
    items,
  } as never);
}

async function placeOk(tenant: TenantKey, tableLabel: string | null, items: Line[], options: PlaceOptions = {}) {
  return okData(await place(tenant, tableLabel, items, options)) as {
    order: { id: string; orderNumber: string; totalAmount: string; status: string };
    kitchen: { tickets: Array<{ kotNumber: string; state: string }> } | null;
  };
}

const sessionOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).tableSessionId;

async function bill(sessionId: string, tenant: TenantKey = "A"): Promise<TableBillView> {
  await asSeedUser(tenant, "CASHIER");
  return okData(await invokeAction(getTableBillAction, { tableSessionId: sessionId })) as TableBillView;
}

async function pay(sessionId: string, amount: string, extra: Record<string, unknown> = {}, idempotencyKey = key()) {
  const current = await bill(sessionId);
  return invokeAction(payTableBillAction, {
    tableSessionId: sessionId,
    idempotencyKey,
    expectedVersion: current.version,
    method: "CARD",
    amount,
    reference: "SLIP-TBL-1",
    ...extra,
  } as never);
}

const money = (value: Prisma.Decimal) => value.toFixed(2);
const sum = (values: Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), new Prisma.Decimal(0));

// ─── Sessions ───

describe("TC-TBL-001/002 the first order opens the table's bill and the next one joins it", () => {
  it("one OPEN session, both orders on it, each with its own KOT", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 2 }], { expected: null });
    const sessionId = (await sessionOf(first.order.id))!;
    expect(sessionId).toBeTruthy();
    const session = await db.tableSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ tenantId: A, status: "OPEN", tableLabel: table });
    expect(session.billNumber).toMatch(/^B-\d{8}-\d{4}$/);

    const second = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }, { menuItemId: CHAI, quantity: 2 }], { expected: sessionId });
    expect(await sessionOf(second.order.id)).toBe(sessionId);
    expect(await db.tableSession.count({ where: { tenantId: A, tableKey: session.tableKey, status: "OPEN" } })).toBe(1);

    // Separate kitchen tickets per order: consolidating the bill never merges preparation.
    const kots = await db.kotTicket.findMany({ where: { tenantId: A, orderId: { in: [first.order.id, second.order.id] } } });
    expect(new Set(kots.map((k) => k.orderId)).size).toBe(2);
  });

  it("the table is the same however staff type it", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const second = await placeOk("A", `  ${table.toLowerCase()} `, [{ menuItemId: CHAI, quantity: 1 }]);
    expect(await sessionOf(second.order.id)).toBe(await sessionOf(first.order.id));
  });

  it("order entry is told which bill an order will join before placing it", async () => {
    const table = newTable();
    await asSeedUser("A", "CASHIER");
    expect(okData(await invokeAction(lookupTableBillAction, { tableLabel: table }))).toBeNull();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const found = okData(await invokeAction(lookupTableBillAction, { tableLabel: table })) as { id: string; orderCount: number };
    expect(found).toMatchObject({ id: await sessionOf(first.order.id), orderCount: 1 });
  });

  it("an order that expected a new bill is refused when the table already has one", async () => {
    const table = newTable();
    await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const refused = errorOf(await place("A", table, [{ menuItemId: CHAI, quantity: 1 }], { expected: null }));
    expect(refused.code).toBe("TABLE_HAS_OPEN_BILL");
  });

  it("two first orders for an empty table at the same instant end up on one bill", async () => {
    const table = newTable();
    const [a, b] = await Promise.all([placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]), placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }])]);
    expect(await sessionOf(a.order.id)).toBe(await sessionOf(b.order.id));
  });
});

describe("TC-TBL-003/004/009/011 the bill holds every order's items, counted once, from their own snapshots", () => {
  it("adds up both orders exactly, groups identical items and stays the same however often it is read", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 2 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const second = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }, { menuItemId: CHAI, quantity: 2 }], { expected: sessionId });

    const orders = await db.order.findMany({ where: { id: { in: [first.order.id, second.order.id] } } });
    const view = await bill(sessionId);
    expect(view.totals.subtotal).toBe(money(sum(orders.map((o) => o.subtotalAmount))));
    expect(view.totals.tax).toBe(money(sum(orders.map((o) => o.taxAmount))));
    expect(view.totals.discount).toBe(money(sum(orders.map((o) => o.discountAmount))));
    expect(view.totals.total).toBe(money(sum(orders.map((o) => o.totalAmount))));
    expect(view.totals.balance).toBe(view.totals.total);

    const chicken = view.lines.find((l) => l.name.startsWith("Chicken 65"))!;
    expect(chicken.quantity).toBe(3);
    expect(chicken.orders.sort()).toEqual([first.order.orderNumber, second.order.orderNumber].sort());
    const lineTotal = sum(view.lines.map((l) => new Prisma.Decimal(l.lineTotal)));
    expect(money(lineTotal)).toBe(money(sum(orders.map((o) => o.subtotalAmount.plus(o.taxAmount)))));

    // Reading again — or with the list — never double-counts.
    expect((await bill(sessionId)).totals).toEqual(view.totals);
    await asSeedUser("A", "CASHIER");
    const open = (okData(await invokeAction(listOpenTableBillsAction)) as Array<{ id: string; total: string }>).find((b) => b.id === sessionId)!;
    expect(open.total).toBe(view.totals.total);
  });
});

describe("TC-TBL-005/006 separate tables and separate restaurants never share a bill", () => {
  it("different tables get different bills", async () => {
    const one = await placeOk("A", newTable(), [{ menuItemId: CHAI, quantity: 1 }]);
    const two = await placeOk("A", newTable(), [{ menuItemId: CHAI, quantity: 1 }]);
    expect(await sessionOf(one.order.id)).not.toBe(await sessionOf(two.order.id));
  });

  it("the same table name in another restaurant is another bill, and B can neither read nor pay A's", async () => {
    const table = newTable();
    const inA = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const bItem = await db.menuItem.findFirstOrThrow({ where: { tenantId: B, isPublished: true, isAvailable: true, archivedAt: null, variants: { none: {} } } });
    const inB = await placeOk("B", table, [{ menuItemId: bItem.id, quantity: 1 }]);
    const sessionA = (await sessionOf(inA.order.id))!;
    expect(await sessionOf(inB.order.id)).not.toBe(sessionA);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: (await sessionOf(inB.order.id))! } })).tenantId).toBe(B);

    await asSeedUser("B", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(getTableBillAction, { tableSessionId: sessionA })).code).toBe("NOT_FOUND");
    const refused = await invokeAction(payTableBillAction, { tableSessionId: sessionA, idempotencyKey: key(), expectedVersion: 0, method: "CASH", amount: "1.00" } as never);
    expect(errorOf(refused).code).toBe("NOT_FOUND");
    expect(await db.tableSessionPayment.count({ where: { tableSessionId: sessionA } })).toBe(0);
    // A tenantId in the body is refused outright.
    expect(errorOf(await invokeAction(getTableBillAction, { tableSessionId: sessionA, tenantId: A } as never)).code).toBe("VALIDATION_ERROR");
  });
});

describe("TC-TBL-007/008 a settled bill takes no more orders; the next order starts a new bill", () => {
  it("refuses a late order aimed at the closed bill, and opens a fresh one when asked to", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const total = (await bill(sessionId)).totals.balance;
    const settled = okData(await pay(sessionId, total)) as TableBillSettlement;
    expect(settled.payment.closed).toBe(true);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("CLOSED");

    const late = errorOf(await place("A", table, [{ menuItemId: CHAI, quantity: 1 }], { expected: sessionId }));
    expect(late.code).toBe("TABLE_BILL_CLOSED");

    const next = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }], { expected: null });
    const nextSession = (await sessionOf(next.order.id))!;
    expect(nextSession).not.toBe(sessionId);
    const view = await bill(nextSession);
    expect(view.orders.map((o) => o.id)).toEqual([next.order.id]);
    expect(view.totals.paid).toBe("0.00");
  });
});

// ─── Billing ───

describe("TC-TBL-010 historical prices stay as they were sold", () => {
  it("a menu price change after the first order moves neither that order nor the bill's earlier line", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const before = await bill(sessionId);
    const item = await db.menuItem.findUniqueOrThrow({ where: { id: CHAI } });
    await db.menuItem.update({ where: { id: CHAI }, data: { basePrice: item.basePrice.plus(10) } });
    try {
      expect((await bill(sessionId)).totals).toEqual(before.totals);
      await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }], { expected: sessionId });
      const after = await bill(sessionId);
      const chaiLines = after.lines.filter((l) => l.name.startsWith(before.lines[0].name));
      expect(chaiLines.map((l) => l.unitPrice).sort()).toEqual([before.lines[0].unitPrice, money(new Prisma.Decimal(before.lines[0].unitPrice).plus(10))].sort());
    } finally {
      await db.menuItem.update({ where: { id: CHAI }, data: { basePrice: item.basePrice } });
    }
  });
});

describe("TC-TBL-012 a part payment reduces the balance and is spread oldest order first", () => {
  it("records one table payment as per-order ledger rows that add up to it", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }], { expected: sessionId });
    const start = await bill(sessionId);
    const firstOrderTotal = new Prisma.Decimal(start.orders[0].total);
    const part = firstOrderTotal.plus("1.00");

    const result = okData(await pay(sessionId, money(part))) as TableBillSettlement;
    expect(result.payment.closed).toBe(false);
    expect(result.payment.balance).toBe(money(new Prisma.Decimal(start.totals.balance).minus(part)));
    expect(result.receipts).toHaveLength(0); // a part payment prints nothing

    const rows = await db.transaction.findMany({ where: { tenantId: A, tableSessionPaymentId: result.payment.paymentId }, orderBy: { createdAt: "asc" } });
    expect(money(sum(rows.map((r) => r.amount)))).toBe(money(part));
    expect(rows.map((r) => r.orderId)).toEqual([start.orders[0].id, start.orders[1].id]);
    expect(money(rows[0].amount)).toBe(money(firstOrderTotal));

    const after = await bill(sessionId);
    expect(after.state).toBe("PARTIALLY_PAID");
    expect(after.totals.paid).toBe(money(part));
    expect(after.payments).toHaveLength(1);
  });

  it("cash over the balance is change, never extra money on the bill", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const due = (await bill(sessionId)).totals.balance;
    const tendered = money(new Prisma.Decimal(due).plus(50));
    const result = okData(await pay(sessionId, tendered, { method: "CASH", reference: undefined, amountTendered: tendered })) as TableBillSettlement;
    expect(result.payment).toMatchObject({ amount: due, changeDue: "50.00", closed: true });
  });

  it("refuses a card amount over the balance, and a UPI payment without a reference", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const due = new Prisma.Decimal((await bill(sessionId)).totals.balance);
    expect(errorOf(await pay(sessionId, money(due.plus(1)))).code).toBe("AMOUNT_EXCEEDS_BALANCE");
    expect(errorOf(await pay(sessionId, money(due), { method: "UPI", reference: undefined })).fieldErrors).toHaveProperty("reference");
    expect(await db.tableSessionPayment.count({ where: { tableSessionId: sessionId } })).toBe(0);
  });
});

describe("TC-TBL-013 a double submit never charges twice", () => {
  it("the same key, twice at once and once more later, is one payment", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const view = await bill(sessionId);
    const idempotencyKey = key();
    const body = { tableSessionId: sessionId, idempotencyKey, expectedVersion: view.version, method: "CARD", amount: view.totals.balance, reference: "SLIP-TBL-DUP" };

    const [a, b] = await Promise.all([invokeAction(payTableBillAction, body as never), invokeAction(payTableBillAction, body as never)]);
    const one = okData(a) as TableBillSettlement;
    const two = okData(b) as TableBillSettlement;
    expect(two.payment.paymentId).toBe(one.payment.paymentId);
    const third = okData(await invokeAction(payTableBillAction, body as never)) as TableBillSettlement;
    expect(third.payment.replayed).toBe(true);

    expect(await db.tableSessionPayment.count({ where: { tableSessionId: sessionId } })).toBe(1);
    expect(await db.transaction.count({ where: { tenantId: A, orderId: first.order.id } })).toBe(1);
    expect(money((await db.order.findUniqueOrThrow({ where: { id: first.order.id } })).paidAmount)).toBe(view.totals.balance);
    const receiptKeys = (await db.printJob.findMany({ where: { tenantId: A, dedupeKey: { startsWith: `RECEIPT:SESSION:${one.payment.paymentId}` } } })).map((j) => j.dedupeKey);
    expect(new Set(receiptKeys).size).toBe(receiptKeys.length);
  });
});

describe("TC-TBL-014 items added while paying can never be collected wrongly or silently dropped", () => {
  it("a payment built on the bill before a new order joined is refused with BILL_CHANGED", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const seen = await bill(sessionId);
    await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }], { expected: sessionId });

    await asSeedUser("A", "CASHIER");
    const stale = await invokeAction(payTableBillAction, { tableSessionId: sessionId, idempotencyKey: key(), expectedVersion: seen.version, method: "CARD", amount: seen.totals.balance, reference: "SLIP-STALE" } as never);
    expect(errorOf(stale).code).toBe("BILL_CHANGED");
    expect(await db.tableSessionPayment.count({ where: { tableSessionId: sessionId } })).toBe(0);
  });

  it("an order and a settling payment racing: either the order is on the paid bill, or it starts a new one — never lost, never paid twice", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const seen = await bill(sessionId);

    await asSeedUser("A", "CASHIER");
    const [payment, order] = await Promise.all([
      invokeAction(payTableBillAction, { tableSessionId: sessionId, idempotencyKey: key(), expectedVersion: seen.version, method: "CARD", amount: seen.totals.balance, reference: "SLIP-RACE" } as never),
      invokeAction(createStaffOrderAction, { idempotencyKey: randomUUID(), orderType: "DINE_IN", tableLabel: table, sendToKitchen: true, items: [{ menuItemId: CHICKEN, quantity: 1 }] } as never),
    ]);
    const placed = okData(order) as { order: { id: string } };
    const placedSession = await sessionOf(placed.order.id);
    if ((payment as { ok: boolean }).ok) {
      // Payment won: it collected exactly what it saw, the bill closed, the late order opened a new bill.
      expect(placedSession).not.toBe(sessionId);
      expect((await db.order.findUniqueOrThrow({ where: { id: placed.order.id } })).paidAmount.toFixed(2)).toBe("0.00");
    } else {
      // Order won: the payment was refused, the order is on the bill, unpaid.
      expect(errorOf(payment).code).toBe("BILL_CHANGED");
      expect(placedSession).toBe(sessionId);
    }
    const final = await bill(sessionId);
    expect(final.totals.balance).toBe(money(sum(final.orders.filter((o) => o.billed).map((o) => new Prisma.Decimal(o.balance)))));
  });
});

describe("TC-TBL-015 a cancelled order is listed but not billed", () => {
  it("drops out of the total and the payable balance", async () => {
    const table = newTable();
    const first = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(first.order.id))!;
    const second = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 2 }], { expected: sessionId });
    await asSeedUser("A", "MANAGER");
    okData(await invokeAction(updateOrderStatusAction, { orderId: second.order.id, status: "CANCELLED", reason: "Guest changed mind" }));

    const view = await bill(sessionId);
    const firstRow = await db.order.findUniqueOrThrow({ where: { id: first.order.id } });
    expect(view.totals.total).toBe(money(firstRow.totalAmount));
    expect(view.orders.find((o) => o.id === second.order.id)).toMatchObject({ billed: false, balance: "0.00" });
    expect(view.lines.some((l) => l.name.startsWith("Chicken 65"))).toBe(false);

    const settled = okData(await pay(sessionId, view.totals.balance)) as TableBillSettlement;
    expect(settled.payment.allocations.map((a) => a.orderId)).toEqual([first.order.id]);
    expect((await db.order.findUniqueOrThrow({ where: { id: second.order.id } })).status).toBe("CANCELLED");
  });

  it("a bill whose every order was cancelled can be closed without a payment", async () => {
    const table = newTable();
    const only = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(only.order.id))!;
    await asSeedUser("A", "MANAGER");
    okData(await invokeAction(updateOrderStatusAction, { orderId: only.order.id, status: "CANCELLED", reason: "Guest left early" }));
    const view = await bill(sessionId);
    expect(view.canClose).toBe(true);
    const closed = okData(await invokeAction(closeTableBillAction, { tableSessionId: sessionId, expectedVersion: view.version })) as TableBillView;
    expect(closed.status).toBe("CLOSED");
  });

  it("a bill with money due cannot be closed by hand", async () => {
    const table = newTable();
    const only = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(only.order.id))!;
    const view = await bill(sessionId);
    expect(errorOf(await invokeAction(closeTableBillAction, { tableSessionId: sessionId, expectedVersion: view.version })).code).toBe("BALANCE_DUE");
  });
});

// ─── KOT print choice ───

describe("TC-TBL-016/017/018 Send to KOT + Print, or Send to KOT only", () => {
  it("+ Print queues the KOT job for the station's printer; the order and ticket are saved", async () => {
    const placed = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: true });
    expect(placed.order.status).toBe("ACCEPTED");
    const tickets = await db.kotTicket.findMany({ where: { tenantId: A, orderId: placed.order.id } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].printRequested).toBe(true);
    expect(await db.printJob.count({ where: { tenantId: A, kotTicketId: tickets[0].id, jobType: "KOT" } })).toBeGreaterThan(0);
  });

  it("KOT only saves the same order and ticket with no print job, and says so", async () => {
    const placed = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: false });
    expect(placed.order.status).toBe("ACCEPTED");
    const tickets = await db.kotTicket.findMany({ where: { tenantId: A, orderId: placed.order.id } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ printRequested: false, status: "QUEUED" });
    expect(await db.printJob.count({ where: { tenantId: A, kotTicketId: tickets[0].id } })).toBe(0);
    expect(placed.kitchen!.tickets.map((t) => t.state)).toEqual(["NOT_PRINTED"]);
  });

  it("the print choice changes nothing about the order: same totals, same table bill", async () => {
    const table = newTable();
    const printed = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }], { printKot: true });
    const sessionId = (await sessionOf(printed.order.id))!;
    const silent = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }], { printKot: false, expected: sessionId });
    expect(silent.order.totalAmount).toBe(printed.order.totalAmount);
    expect(await sessionOf(silent.order.id)).toBe(sessionId);
    const rows = await db.order.findMany({ where: { id: { in: [printed.order.id, silent.order.id] } } });
    expect(new Set(rows.map((r) => r.paymentStatus))).toEqual(new Set(["UNPAID"]));
  });
});

describe("TC-TBL-019 a KOT-only ticket is on the kitchen screen and moves like any other", () => {
  it("appears on the kitchen board with its print state, and the chef can prepare it", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const placed = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: false });
    const ticket = await db.kotTicket.findFirstOrThrow({ where: { tenantId: A, orderId: placed.order.id } });
    await asSeedUser("A", "KITCHEN");
    const board = await invokeRoute(kitchenTicketsRoute, { url: `/api/v1/kitchen/tickets?since=${encodeURIComponent(since)}` });
    expect(board.status).toBe(200);
    const card = (board.body as { tickets: Array<{ id: string; printStatus: string }> }).tickets.find((t) => t.id === ticket.id);
    expect(card).toMatchObject({ printStatus: "NOT_REQUESTED" });
    // The older list action still lists it too.
    expect(JSON.stringify(okData(await invokeAction(getKOTTicketsAction, {})))).toContain(ticket.id);
    okData(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "PREPARING" }));
    expect((await db.order.findUniqueOrThrow({ where: { id: placed.order.id } })).status).toBe("PREPARING");
  });
});

describe("TC-TBL-020 a duplicate submission creates no second KOT or job", () => {
  it("the same key with either choice replays the first order", async () => {
    const idempotencyKey = randomUUID();
    const one = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: true, idempotencyKey });
    const two = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: false, idempotencyKey });
    expect(two.order.id).toBe(one.order.id);
    expect(await db.kotTicket.count({ where: { tenantId: A, orderId: one.order.id } })).toBe(1);
    expect(await db.printJob.count({ where: { tenantId: A, kotTicket: { orderId: one.order.id } } })).toBe(1);
  });
});

describe("TC-TBL-021 a printer failure never loses the digital KOT", () => {
  it("the ticket stays on the kitchen screen when its print job failed", async () => {
    const placed = await placeOk("A", null, [{ menuItemId: CHICKEN, quantity: 1 }], { orderType: "TAKEAWAY", printKot: true });
    const ticket = await db.kotTicket.findFirstOrThrow({ where: { tenantId: A, orderId: placed.order.id } });
    await db.printJob.updateMany({ where: { tenantId: A, kotTicketId: ticket.id }, data: { status: "FAILED", failedAt: new Date(), lastErrorCode: "PRINTER_OFFLINE" } });
    await asSeedUser("A", "KITCHEN");
    expect(JSON.stringify(okData(await invokeAction(getKOTTicketsAction, {})))).toContain(ticket.id);
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("QUEUED");
  });
});

// ─── Receipts ───

async function settledTable() {
  const table = newTable();
  const first = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 2 }]);
  const sessionId = (await sessionOf(first.order.id))!;
  const second = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }, { menuItemId: CHAI, quantity: 2 }], { expected: sessionId });
  const before = await bill(sessionId);
  const settled = okData(await pay(sessionId, before.totals.balance)) as TableBillSettlement;
  return { sessionId, first, second, before, settled };
}

const sessionReceiptJobs = (paymentId: string) =>
  db.printJob.findMany({ where: { tenantId: A, jobType: "RECEIPT", dedupeKey: { startsWith: `RECEIPT:SESSION:${paymentId}` } }, orderBy: { copyIndex: "asc" } });

describe("TC-TBL-023/024/026 settling the table queues one consolidated receipt, nothing per order", () => {
  it("one receipt set covering every order, with the printer's copy labels and no per-order receipts", async () => {
    const { first, second, before, settled } = await settledTable();
    expect(settled.payment.closed).toBe(true);
    expect(settled.receiptQueue).toBe("QUEUED");

    const jobs = await sessionReceiptJobs(settled.payment.paymentId);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(settled.receipts.map((r) => r.printJobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(settled.receipts.every((r) => r.status === "QUEUED")).toBe(true);
    const printer = await db.printer.findUniqueOrThrow({ where: { id: jobs[0].printerId } });
    expect(jobs).toHaveLength(Math.max(1, printer.receiptCopies));
    if (jobs.length === 2) expect(jobs.map((j) => j.copyLabel)).toEqual(["CUSTOMER COPY", "RESTAURANT COPY"]);

    const text = JSON.stringify(jobs[0].payload);
    const session = await db.tableSession.findUniqueOrThrow({ where: { id: settled.payment.tableSessionId } });
    expect(text).toContain(session.billNumber);
    expect(text).toContain(first.order.orderNumber);
    expect(text).toContain(second.order.orderNumber);
    expect(text).toContain("3 x Chicken 65");
    expect(text).toContain(before.totals.total.replace(/\B(?=(\d{3})+(?!\d))/g, ","));

    // No receipt for either order on its own.
    expect(await db.printJob.count({ where: { tenantId: A, jobType: "RECEIPT", orderId: { in: [first.order.id, second.order.id] } } })).toBe(0);
  });
});

describe("TC-TBL-022/025 a printing failure never reverses the payment; retry reuses the same jobs", () => {
  it("FAILED copies go back in the queue as the same jobs, with no second payment", async () => {
    const { sessionId, settled } = await settledTable();
    const jobs = await sessionReceiptJobs(settled.payment.paymentId);
    await db.printJob.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { status: "FAILED", failedAt: new Date(), lastErrorCode: "PRINTER_OFFLINE", lastErrorMessage: "Printer offline" } });

    await asSeedUser("A", "CASHIER");
    const failed = okData(await invokeAction(getTableBillReceiptsAction, { paymentId: settled.payment.paymentId })) as TableBillSettlement["receipts"];
    expect(failed.every((r) => r.status === "FAILED")).toBe(true);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("CLOSED");

    const retried = okData(await invokeAction(retryTableBillReceiptsAction, { paymentId: settled.payment.paymentId })) as TableBillSettlement["receipts"];
    expect(retried.map((r) => r.printJobId).sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(retried.every((r) => r.status === "QUEUED")).toBe(true);
    okData(await invokeAction(retryTableBillReceiptsAction, { paymentId: settled.payment.paymentId }));
    expect(await sessionReceiptJobs(settled.payment.paymentId)).toHaveLength(jobs.length);
    expect(await db.tableSessionPayment.count({ where: { tableSessionId: sessionId } })).toBe(1);
  });
});

describe("TC-TBL-027 the consolidated receipt is a document installed agents accept", () => {
  it("strict v1 wire format without copy metadata", async () => {
    const { settled } = await settledTable();
    for (const job of await sessionReceiptJobs(settled.payment.paymentId)) {
      expect(printDocumentSchema.safeParse(job.payload).success).toBe(true);
      expect(Object.keys(job.payload as object).sort()).toEqual(["blocks", "version", "widthMm"]);
    }
  });
});

describe("TC-TBL-023b settling completes READY orders only, through the normal lifecycle", () => {
  it("a READY order completes, an order still in the kitchen stays open", async () => {
    const table = newTable();
    const ready = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(ready.order.id))!;
    const cooking = await placeOk("A", table, [{ menuItemId: CHICKEN, quantity: 1 }], { expected: sessionId });
    await db.order.update({ where: { id: ready.order.id }, data: { status: "READY", readyAt: new Date() } });

    const view = await bill(sessionId);
    const settled = okData(await pay(sessionId, view.totals.balance)) as TableBillSettlement;
    expect(Object.fromEntries(settled.completions.map((c) => [c.orderId, c.completion]))).toEqual({ [ready.order.id]: "COMPLETED", [cooking.order.id]: "NOT_READY" });
    expect((await db.order.findUniqueOrThrow({ where: { id: cooking.order.id } })).status).toBe("ACCEPTED");
    expect((await db.order.findUniqueOrThrow({ where: { id: cooking.order.id } })).paymentStatus).toBe("PAID");
  });
});

// ─── Regression ───

describe("TC-TBL-028/029 takeaway and delivery orders never join a table bill", () => {
  it("even with a table label sent, they stay on their own", async () => {
    for (const orderType of ["TAKEAWAY", "DELIVERY"] as const) {
      const placed = await placeOk("A", newTable(), [{ menuItemId: CHAI, quantity: 1 }], { orderType });
      expect(await sessionOf(placed.order.id)).toBeNull();
    }
  });

  it("a dine-in order without a table stays on its own bill, payable per order as before", async () => {
    const placed = await placeOk("A", null, [{ menuItemId: CHAI, quantity: 1 }]);
    expect(await sessionOf(placed.order.id)).toBeNull();
    await asSeedUser("A", "CASHIER");
    const paid = okData(await invokeAction(recordPaymentAction, { orderId: placed.order.id, idempotencyKey: key(), method: "CARD", amount: placed.order.totalAmount, reference: "SLIP-SOLO" }));
    expect(paid.paymentStatus).toBe("PAID");
  });
});

describe("TC-TBL-031 an order on an open table bill is paid with the bill, in either workflow", () => {
  it("per-order payment and the simplified board's settle both point to the table bill", async () => {
    const table = newTable();
    const placed = await placeOk("A", table, [{ menuItemId: CHAI, quantity: 1 }]);
    await asSeedUser("A", "CASHIER");
    const refused = errorOf(await invokeAction(recordPaymentAction, { orderId: placed.order.id, idempotencyKey: key(), method: "CARD", amount: placed.order.totalAmount, reference: "SLIP-ORD" }));
    expect(refused.code).toBe("TABLE_BILL");

    await db.restaurant.update({ where: { tenantId: A }, data: { simplifiedWorkflow: true } });
    const viaBoard = errorOf(await invokeAction(settleOrderAction, { orderId: placed.order.id, idempotencyKey: key(), method: "CARD", amount: placed.order.totalAmount, reference: "SLIP-BRD" } as never));
    expect(viaBoard.code).toBe("TABLE_BILL");
    expect(await db.transaction.count({ where: { tenantId: A, orderId: placed.order.id } })).toBe(0);
  });
});

describe("TC-TBL-032 roles", () => {
  it("the kitchen cannot read or pay a table bill; a waiter cannot pay one", async () => {
    const placed = await placeOk("A", newTable(), [{ menuItemId: CHAI, quantity: 1 }]);
    const sessionId = (await sessionOf(placed.order.id))!;
    await asSeedUser("A", "KITCHEN");
    expect(errorOf(await invokeAction(getTableBillAction, { tableSessionId: sessionId })).code).toBe("FORBIDDEN");
    expect(errorOf(await invokeAction(payTableBillAction, { tableSessionId: sessionId, idempotencyKey: key(), expectedVersion: 0, method: "CASH", amount: "1.00" } as never)).code).toBe("FORBIDDEN");
    await asSeedUser("A", "WAITER");
    expect(errorOf(await invokeAction(payTableBillAction, { tableSessionId: sessionId, idempotencyKey: key(), expectedVersion: 0, method: "CASH", amount: "1.00" } as never)).code).toBe("FORBIDDEN");
  });
});
