import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import OrderDetailPage from "@/app/restaurant/orders/[orderId]/page";
import NewOrderPage from "@/app/restaurant/orders/new/page";
import OrdersPage from "@/app/restaurant/orders/page";
import { createStaffOrderAction, quoteOrderAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { setMenuItemAvailabilityAction } from "@/app/restaurant/menu/items-actions";
import { OrderBoard } from "@/components/orders/order-board";
import { OrderCustomerPanel } from "@/components/orders/order-customer-panel";
import { OrderDetailActions } from "@/components/orders/order-detail-actions";
import { OrderEntry } from "@/components/orders/order-entry";
import { OrderLinesTable } from "@/components/orders/order-lines-table";
import { PaymentPanel } from "@/components/transactions/payment-panel";
import { OrderTimeline } from "@/components/orders/order-timeline";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, invokeLoader, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { findComponent, hrefs, requireComponent, textOf } from "../menu/ui-tree";
import { dataOf, errorOf } from "./helpers";

/**
 * TC-ORDER-015 / TC-ORDER-016 / TC-ORDER-017 as integration tests.
 *
 * The console has no authenticated end-to-end path in this environment (testing.md §2: Clerk has no test users), so
 * each screen is driven through its loader instead: `invokeLoader` runs the Server Component as the seeded user and
 * the assertions are on the tree it produced — the data it resolved, the capability flags it passed down and the
 * branch it chose. The browser interactions those TCs describe (double-tapping submit, a second browser, the cancel
 * dialog) are exercised at the action they call, which is where the rule actually lives.
 */
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

const params = (orderId: string) => ({ params: Promise.resolve({ orderId }) });

describe("TC-ORDER-016 order board screen (/restaurant/orders)", () => {
  it("renders the live board from the server with this role's own transitions", async () => {
    await asSeedUser("A", "MANAGER");
    const page = await invokeLoader(OrdersPage, { searchParams: Promise.resolve({ view: "all" }) });
    const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(page, OrderBoard, "OrderBoard");

    expect(board.initial.items.length).toBeGreaterThan(0);
    expect(board.timezone).toBe("Asia/Kolkata");
    expect(board.canCreate).toBe(true);
    // The server decides what a manager may request from each status (SA-ORD-02/03).
    expect(board.transitions.NEW.sort()).toEqual(["ACCEPTED", "CANCELLED"]);
    expect(board.transitions.ACCEPTED.sort()).toEqual(["CANCELLED", "PREPARING"]);
    expect(board.transitions.COMPLETED).toEqual([]);
    expect(hrefs(page)).toContain("/restaurant/orders/new");
  });

  it("shows a kitchen user no totals, no customer names and no way to create an order", async () => {
    await asSeedUser("A", "KITCHEN");
    const page = await invokeLoader(OrdersPage, { searchParams: Promise.resolve({ view: "all" }) });
    const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(page, OrderBoard, "OrderBoard");

    expect(board.canCreate).toBe(false);
    expect(board.initial.items.every((order) => order.totalAmount === null && order.customerName === null)).toBe(true);
    expect(board.transitions.ACCEPTED).toEqual(["PREPARING"]);
    expect(board.transitions.NEW).toEqual([]);
    expect(hrefs(page)).not.toContain("/restaurant/orders/new");
  });

  it("a cashier's board carries money but only the moves a cashier may make", async () => {
    await asSeedUser("A", "CASHIER");
    const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(await invokeLoader(OrdersPage, { searchParams: Promise.resolve({ view: "all" }) }), OrderBoard, "OrderBoard");
    expect(board.initial.items.some((order) => order.totalAmount !== null)).toBe(true);
    expect(board.transitions.NEW.sort()).toEqual(["ACCEPTED", "CANCELLED"]);
    expect(board.transitions.ACCEPTED).toEqual([]);
    expect(board.transitions.READY).toEqual(["COMPLETED"]);
  });
});

describe("TC-ORDER-015 order entry (/restaurant/orders/new)", () => {
  it("loads the orderable catalogue with today's daily-menu highlight and the role's own flags", async () => {
    await asSeedUser("A", "WAITER");
    const page = await invokeLoader(NewOrderPage, { searchParams: Promise.resolve({}) });
    const entry = requireComponent<React.ComponentProps<typeof OrderEntry>>(page, OrderEntry, "OrderEntry");

    expect(entry.catalogue.items.length).toBeGreaterThan(0);
    expect(entry.catalogue.categories.map((category) => category.name)).toContain("Starters");
    expect(entry.catalogue.defaults.currencyCode).toBe("INR");
    // Paneer Tikka has variants, so its tile must open the options dialog rather than add a line directly.
    const paneer = entry.catalogue.items.find((item) => item.id === seeded("A", "item:paneer-tikka"));
    expect(paneer?.hasOptions).toBe(true);
    // Chicken 65 has neither variants nor add-ons: one tap adds it.
    expect(entry.catalogue.items.find((item) => item.id === seeded("A", "item:chicken-65"))?.hasOptions).toBe(false);

    // A waiter may take the order and send it to the kitchen, but may not mark it urgent (api.md SA-ORD-01).
    expect(entry.canSendToKitchen).toBe(true);
    expect(entry.canSetPriority).toBe(false);
    expect(entry.canCreateCustomer).toBe(true);
  });

  it("only lists items that can actually be ordered", async () => {
    await asSeedUser("A", "MANAGER");
    const itemId = seeded("A", "item:masala-omelette");
    dataOf(await invokeAction(setMenuItemAvailabilityAction, { itemId, available: false }));

    const entry = requireComponent<React.ComponentProps<typeof OrderEntry>>(await invokeLoader(NewOrderPage, { searchParams: Promise.resolve({}) }), OrderEntry, "OrderEntry");
    expect(entry.catalogue.items.map((item) => item.id)).not.toContain(itemId);

    dataOf(await invokeAction(setMenuItemAvailabilityAction, { itemId, available: true }));
  });

  it("prices the cart on the server and refuses a client-supplied price", async () => {
    await asSeedUser("A", "WAITER");
    const quote = dataOf(
      await invokeAction(quoteOrderAction, {
        items: [
          { menuItemId: seeded("A", "item:paneer-tikka"), variantId: seeded("A", "variant:paneer-tikka:1"), quantity: 2 },
          { menuItemId: seeded("A", "item:butter-chicken"), addonIds: [seeded("A", "addon:butter-chicken:0")], quantity: 1 },
        ],
      }),
    );
    // 2 × 280.00 = 560.00 plus 360.00 + 30.00 = 390.00 → 950.00 subtotal at 5 % tax.
    expect(quote.subtotalAmount).toBe("950.00");
    expect(quote.taxAmount).toBe("47.50");
    expect(quote.totalAmount).toBe("997.50");
    expect(quote.currencyCode).toBe("INR");

    const rejected = errorOf(await invokeAction(quoteOrderAction, { items: [{ menuItemId: seeded("A", "item:chicken-65"), quantity: 1, unitPrice: "1.00" }] } as never));
    expect(rejected.code).toBe("VALIDATION_ERROR");
  });

  it("a repeated submit with the same idempotency key creates one order (double tap)", async () => {
    await asSeedUser("A", "WAITER");
    const idempotencyKey = randomUUID();
    const payload = {
      idempotencyKey,
      orderType: "DINE_IN" as const,
      tableLabel: "T9",
      sendToKitchen: true,
      items: [{ menuItemId: seeded("A", "item:chicken-65"), quantity: 1 }],
    };

    const first = dataOf(await invokeAction(createStaffOrderAction, payload));
    const second = dataOf(await invokeAction(createStaffOrderAction, payload));
    expect(second.order.id).toBe(first.order.id);
    expect(await db.order.count({ where: { tenantId: A, idempotencyKey } })).toBe(1);
    expect(first.order.status).toBe("ACCEPTED");
    expect(first.order.totalAmount).toBe("252.00");
  });

  it("an unavailable item comes back as a 422 naming the line the POS must fix", async () => {
    await asSeedUser("A", "MANAGER");
    const itemId = seeded("A", "item:dal-makhani");
    dataOf(await invokeAction(setMenuItemAvailabilityAction, { itemId, available: false }));

    const failure = errorOf(
      await invokeAction(createStaffOrderAction, {
        idempotencyKey: randomUUID(),
        orderType: "TAKEAWAY",
        sendToKitchen: false,
        items: [{ menuItemId: seeded("A", "item:chicken-65"), quantity: 1 }, { menuItemId: itemId, quantity: 1 }],
      }),
    );
    expect(failure.code).toBe("ITEM_UNAVAILABLE");
    expect(Object.keys(failure.fieldErrors ?? {}).some((field) => field.startsWith("items.1"))).toBe(true);

    dataOf(await invokeAction(setMenuItemAvailabilityAction, { itemId, available: true }));
  });
});

describe("TC-ORDER-017 order detail (/restaurant/orders/[orderId])", () => {
  it("renders the order's snapshots, tickets, payment state and the manager's own actions", async () => {
    await asSeedUser("A", "MANAGER");
    const page = await invokeLoader(OrderDetailPage, params(seeded("A", "order:o3")));

    const lines = requireComponent<React.ComponentProps<typeof OrderLinesTable>>(page, OrderLinesTable, "OrderLinesTable");
    expect(lines.order.lines.map((line) => line.itemNameSnapshot)).toContain("Chicken 65");
    expect(lines.order.lines.some((line) => line.specialInstructions === "Less spicy")).toBe(true);
    expect(lines.order.kots.length).toBeGreaterThan(0);

    const timeline = requireComponent<React.ComponentProps<typeof OrderTimeline>>(page, OrderTimeline, "OrderTimeline");
    expect(timeline.entries.some((entry) => entry.action === "order.created")).toBe(true);

    const rendered = textOf(page);
    expect(rendered).toContain("Kitchen tickets");
    // The balance now lives in the client PaymentPanel, so it is asserted on what the page hands it (S1-P18-T006).
    const payment = requireComponent<React.ComponentProps<typeof PaymentPanel>>(page, PaymentPanel, "PaymentPanel");
    expect(payment.balanceDue).not.toBeNull();
    expect(payment.can.recordPayment).toBe(true);

    const actions = requireComponent<React.ComponentProps<typeof OrderDetailActions>>(page, OrderDetailActions, "OrderDetailActions");
    expect(actions.allowedActions).toContain("CANCELLED");
    expect(actions.allowedActions).toContain("SET_HIGH_PRIORITY");
    expect(actions.version).toBeGreaterThanOrEqual(0);
    expect(findComponent(page, OrderCustomerPanel)).not.toBeNull();
  });

  it("hides money and the customer panel from the kitchen", async () => {
    await asSeedUser("A", "KITCHEN");
    const page = await invokeLoader(OrderDetailPage, params(seeded("A", "order:o3")));
    // KITCHEN may not see money at all: the panel is not on the page, and no ledger row was even loaded.
    expect(findComponent(page, PaymentPanel)).toBeNull();
    const actions = requireComponent<React.ComponentProps<typeof OrderDetailActions>>(page, OrderDetailActions, "OrderDetailActions");
    expect(actions.allowedActions).not.toContain("SET_CUSTOMER");
  });

  it("a manager cancels a NEW order with a reason, and the reason reaches the activity list", async () => {
    await asSeedUser("A", "MANAGER");
    const orderId = seeded("A", "order:o1");
    const reason = "Guest left before ordering";
    dataOf(await invokeAction(updateOrderStatusAction, { orderId, status: "CANCELLED", reason }));

    const page = await invokeLoader(OrderDetailPage, params(orderId));
    expect(textOf(page)).toContain(reason);
    const timeline = requireComponent<React.ComponentProps<typeof OrderTimeline>>(page, OrderTimeline, "OrderTimeline");
    expect(timeline.entries.some((entry) => entry.action === "order.cancelled" && entry.reason === reason)).toBe(true);

    // A reason under five characters is refused by the server, not by the dialog alone.
    expect(errorOf(await invokeAction(updateOrderStatusAction, { orderId: seeded("A", "order:o4"), status: "CANCELLED", reason: "no" })).fieldErrors?.reason).toBeTruthy();
  });

  it("another restaurant's order id renders the not-found page, like an unknown id", async () => {
    await asSeedUser("A", "MANAGER");
    expect(await invokeLoader(OrderDetailPage, params(seeded("B", "order:o1")))).toEqual({ notFound: true });
    expect(await invokeLoader(OrderDetailPage, params("not-a-uuid"))).toEqual({ notFound: true });
  });
});
