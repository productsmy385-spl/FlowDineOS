import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import DineInPage from "@/app/restaurant/dine-in/page";
import NewOrderPage from "@/app/restaurant/orders/new/page";
import OrdersPage from "@/app/restaurant/orders/page";
import { createStaffOrderAction } from "@/app/restaurant/orders/actions";
import { getTableBillAction, listDineInTablesAction, payTableBillAction } from "@/app/restaurant/orders/table-actions";
import { DineInTables } from "@/components/orders/dine-in-tables";
import { OrderBoard } from "@/components/orders/order-board";
import { OrderEntry } from "@/components/orders/order-entry";
import { OrdersViewSwitch } from "@/components/orders/orders-view-switch";
import type { DineInTable, TableBillView } from "@/lib/services/table-sessions";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, invokeLoader, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { errorOf, key, okData } from "../money/helpers";
import { findComponent, hrefs, requireComponent } from "../menu/ui-tree";

/**
 * Orders UI: Dine-in table grid, Takeaway view, + Add Items (owner brief 2026-10-14; RASOIOS-ADR-027).
 * Screens are driven through their loaders as the seeded users, the same way the other screen tests are.
 */
const db = testDb();
const A = tenantIdOf("A");
const B = tenantIdOf("B");
const CHAI = seeded("A", "item:masala-chai");
const view = (v?: string) => ({ searchParams: Promise.resolve(v ? { view: v } : {}) });

beforeAll(seedOnce, 120_000);

let n = 0;
const label = () => `DV${process.pid % 1000}-${++n}`;

async function addConfiguredTable(tenantId: string, tableLabel: string) {
  return db.diningTable.create({ data: { tenantId, label: tableLabel, publicCode: `c${randomUUID().replace(/-/g, "").slice(0, 11)}` } });
}

async function placeDineIn(tableLabel: string, expected?: string | null) {
  await asSeedUser("A", "CASHIER");
  return okData(
    await invokeAction(createStaffOrderAction, {
      idempotencyKey: randomUUID(),
      orderType: "DINE_IN",
      tableLabel,
      sendToKitchen: true,
      ...(expected === undefined ? {} : { expectedTableSessionId: expected }),
      items: [{ menuItemId: CHAI, quantity: 1 }],
    } as never),
  ) as { order: { id: string; totalAmount: string } };
}

async function tables(role: "CASHIER" | "WAITER" | "KITCHEN" = "CASHIER") {
  await asSeedUser("A", role);
  return okData(await invokeAction(listDineInTablesAction)) as DineInTable[];
}

describe("Dine-in page and Orders views", () => {
  it("Dine-in is its own page with the table grid", async () => {
    await asSeedUser("A", "CASHIER");
    const page = await invokeLoader(DineInPage);
    const grid = requireComponent<React.ComponentProps<typeof DineInTables>>(page, DineInTables, "DineInTables");
    expect(grid.can).toEqual({ createOrder: true, viewBill: true });
    expect(findComponent(page, OrderBoard)).toBeNull();
  });

  it("Orders opens on Takeaway, and an old ?view=dine-in link goes to the Dine-in page", async () => {
    await asSeedUser("A", "CASHIER");
    const page = await invokeLoader(OrdersPage, view());
    expect(requireComponent(page, OrdersViewSwitch, "OrdersViewSwitch").active).toBe("takeaway");
    expect(findComponent(page, DineInTables)).toBeNull();
    expect(await invokeLoader(OrdersPage, view("dine-in"))).toEqual({ redirect: "/restaurant/dine-in" });
  });

  it("Takeaway shows only takeaway orders and polls only those", async () => {
    await asSeedUser("A", "CASHIER");
    await invokeAction(createStaffOrderAction, { idempotencyKey: randomUUID(), orderType: "TAKEAWAY", sendToKitchen: true, items: [{ menuItemId: CHAI, quantity: 1 }] } as never);
    const page = await invokeLoader(OrdersPage, view("takeaway"));
    const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(page, OrderBoard, "OrderBoard");
    expect(board.orderType).toBe("TAKEAWAY");
    expect(board.initial.items.length).toBeGreaterThan(0);
    expect(board.initial.items.every((order) => order.orderType === "TAKEAWAY")).toBe(true);
    expect(board.openTables).toBeNull();
    expect(findComponent(page, DineInTables)).toBeNull();
    expect(hrefs(page)).toContain("/restaurant/orders/new?type=TAKEAWAY");
  });

  it("All orders keeps the full board, delivery included", async () => {
    await asSeedUser("A", "CASHIER");
    const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(await invokeLoader(OrdersPage, view("all")), OrderBoard, "OrderBoard");
    expect(board.orderType).toBeUndefined();
  });

  it("an unknown view falls back to Takeaway", async () => {
    await asSeedUser("A", "CASHIER");
    expect(requireComponent(await invokeLoader(OrdersPage, view("nonsense")), OrdersViewSwitch, "OrdersViewSwitch").active).toBe("takeaway");
  });
});

describe("Dine-in table grid", () => {
  it("a configured table is Available until an order opens its bill, then Occupied with its orders and amount", async () => {
    const t = label();
    await addConfiguredTable(A, t);
    expect((await tables()).find((x) => x.label === t)).toMatchObject({ bill: null });

    const first = await placeDineIn(t, null);
    const second = await placeDineIn(t.toLowerCase());
    const card = (await tables()).find((x) => x.label === t)!;
    expect(card.bill).toMatchObject({ orderCount: 2 });
    const bill = okData(await invokeAction(getTableBillAction, { tableSessionId: card.bill!.id })) as TableBillView;
    expect(bill.orders.map((o) => o.id).sort()).toEqual([first.order.id, second.order.id].sort());
    expect(card.bill!.balance).toBe(bill.totals.balance);
    // One card per table, however the label was typed.
    expect((await tables()).filter((x) => x.key === t.toUpperCase())).toHaveLength(1);
  });

  it("a settled table is Available again — a closed bill is never shown as an unpaid one", async () => {
    const t = label();
    await addConfiguredTable(A, t);
    await placeDineIn(t);
    const card = (await tables()).find((x) => x.label === t)!;
    const bill = okData(await invokeAction(getTableBillAction, { tableSessionId: card.bill!.id })) as TableBillView;
    okData(await invokeAction(payTableBillAction, { tableSessionId: bill.id, idempotencyKey: key(), expectedVersion: bill.version, method: "CARD", amount: bill.totals.balance, reference: "SLIP-DV" } as never));
    expect((await tables()).find((x) => x.label === t)!.bill).toBeNull();
  });

  it("a table typed on an order but not configured still gets a card while its bill is open", async () => {
    const t = label();
    await placeDineIn(t);
    expect((await tables()).find((x) => x.label === t)).toMatchObject({ diningTableId: null, bill: { orderCount: 1 } });
  });

  it("a waiter sees status and orders but no amounts; another restaurant's tables never appear", async () => {
    const t = label();
    await addConfiguredTable(A, t);
    await placeDineIn(t);
    const card = (await tables("WAITER")).find((x) => x.label === t)!;
    expect(card.bill).toMatchObject({ balance: null, total: null, orderCount: 1 });

    const other = label();
    await addConfiguredTable(B, other);
    expect((await tables()).some((x) => x.label === other)).toBe(false);
  });

  it("the kitchen can see the grid without amounts", async () => {
    const all = await tables("KITCHEN");
    expect(all.every((x) => x.bill === null || x.bill.balance === null)).toBe(true);
  });
});

describe("+ Add Items to an open bill", () => {
  it("opens order entry fixed to that table and bill", async () => {
    const t = label();
    const placed = await placeDineIn(t);
    const sessionId = (await db.order.findUniqueOrThrow({ where: { id: placed.order.id } })).tableSessionId!;
    await asSeedUser("A", "WAITER");
    const entry = requireComponent<React.ComponentProps<typeof OrderEntry>>(await invokeLoader(NewOrderPage, { searchParams: Promise.resolve({ bill: sessionId }) }), OrderEntry, "OrderEntry");
    expect(entry.addToBill).toMatchObject({ id: sessionId, tableLabel: t, canViewBill: false });
  });

  it("a new order sent for the bill joins it with its own KOT; the earlier order is unchanged", async () => {
    const t = label();
    const first = await placeDineIn(t);
    const sessionId = (await db.order.findUniqueOrThrow({ where: { id: first.order.id } })).tableSessionId!;
    const before = await db.order.findUniqueOrThrow({ where: { id: first.order.id } });
    const added = await placeDineIn(t, sessionId);
    expect((await db.order.findUniqueOrThrow({ where: { id: added.order.id } })).tableSessionId).toBe(sessionId);
    const kots = await db.kotTicket.findMany({ where: { tenantId: A, orderId: { in: [first.order.id, added.order.id] } } });
    expect(new Set(kots.map((k) => k.orderId)).size).toBe(2);
    const after = await db.order.findUniqueOrThrow({ where: { id: first.order.id } });
    expect(after.totalAmount.toFixed(2)).toBe(before.totalAmount.toFixed(2));
    expect(await db.tableSession.count({ where: { tenantId: A, tableKey: t.toUpperCase() } })).toBe(1);
  });

  it("a bill settled while the screen was open refuses the items and opens nothing new", async () => {
    const t = label();
    const first = await placeDineIn(t);
    const sessionId = (await db.order.findUniqueOrThrow({ where: { id: first.order.id } })).tableSessionId!;
    await asSeedUser("A", "CASHIER");
    const bill = okData(await invokeAction(getTableBillAction, { tableSessionId: sessionId })) as TableBillView;
    okData(await invokeAction(payTableBillAction, { tableSessionId: sessionId, idempotencyKey: key(), expectedVersion: bill.version, method: "CARD", amount: bill.totals.balance, reference: "SLIP-DV2" } as never));

    const refused = errorOf(
      await invokeAction(createStaffOrderAction, {
        idempotencyKey: randomUUID(),
        orderType: "DINE_IN",
        tableLabel: t,
        sendToKitchen: true,
        expectedTableSessionId: sessionId,
        items: [{ menuItemId: CHAI, quantity: 1 }],
      } as never),
    );
    expect(refused.code).toBe("TABLE_BILL_CLOSED");
    expect(await db.tableSession.count({ where: { tenantId: A, tableKey: t.toUpperCase() } })).toBe(1);

    // Opening the Add Items screen for the closed bill shows why, not the order form.
    const page = await invokeLoader(NewOrderPage, { searchParams: Promise.resolve({ bill: sessionId }) });
    expect(findComponent(page, OrderEntry)).toBeNull();
    expect(JSON.stringify(page)).toContain(`Table ${t}'s bill ${bill.billNumber} is closed`);
  });

  it("another restaurant's bill id shows not-found, never its table", async () => {
    const t = label();
    const placed = await placeDineIn(t);
    const sessionId = (await db.order.findUniqueOrThrow({ where: { id: placed.order.id } })).tableSessionId!;
    await asSeedUser("B", "TENANT_ADMIN");
    const page = await invokeLoader(NewOrderPage, { searchParams: Promise.resolve({ bill: sessionId }) });
    expect(findComponent(page, OrderEntry)).toBeNull();
    expect(JSON.stringify(page)).not.toContain(t);
  });
});
