import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/orders/route";
import { updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { getOrderDetail, type OrderAction } from "@/lib/services/orders";
import { testDb } from "../setup/db";
import { asAnonymous, asSeedUser, invokeAction, invokeRoute, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { dataOf, expectSameNotFound, RANDOM_UUID } from "./helpers";

/**
 * TC-ORDER-010 / TC-ORDER-011 — LD-ORD-01, RH-ORD-01 and LD-ORD-02 (S1-P12-T006).
 *
 * The board is a projection of the caller's own tenant: the kitchen never receives a customer name or an amount
 * (SC-RBAC-07), a poll returns exactly what changed since the cursor — including orders that have just closed, so a
 * client can move their cards — and the detail's `allowedActions` are the server's answer for that caller, not a
 * client's guess (SC-RBAC-08).
 */
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

type Board = { items: Array<Record<string, unknown>>; serverTime: string; hasMore: boolean };

const poll = (query: Record<string, string> = {}) => invokeRoute(GET as never, { url: `/api/v1/orders?${new URLSearchParams(query).toString()}` });

/** LD-ORD-02 through the same envelope a loader would see, so NOT_FOUND can be compared character for character. */
const detailAction = action(async (orderId: string) => {
  const ctx = await requireTenant("order:read");
  return getOrderDetail(ctx, orderId);
});

describe("TC-ORDER-010 order board polling", () => {
  it("returns this tenant's working board: active orders urgent-first, then today's closed ones", async () => {
    await asSeedUser("A", "MANAGER");
    const response = await poll();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const board = response.body as Board;

    const active = await db.order.count({ where: { tenantId: A, status: { in: ["NEW", "ACCEPTED", "PREPARING", "READY"] } } });
    expect(board.items.length).toBeGreaterThanOrEqual(active);
    expect(Date.parse(board.serverTime)).toBeGreaterThan(0);
    expect(board.hasMore).toBe(false);

    expect(Object.keys(board.items[0]).sort()).toEqual(
      [
        "id", "orderNumber", "status", "paymentStatus", "orderType", "tableLabel", "priority",
        "customerName", "currencyCode", "totalAmount", "itemCount", "lines", "imageUrl", "createdAt", "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(board)).not.toContain(tenantIdOf("B"));

    // Priority desc, then oldest first, among the active ones.
    const keys = board.items
      .filter((order) => ["NEW", "ACCEPTED", "PREPARING", "READY"].includes(String(order.status)))
      .map((order) => [order.priority === "HIGH" ? 0 : 1, Date.parse(String(order.createdAt))] as const);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  });

  it("delivers only what changed after the cursor, terminal transitions included", async () => {
    await asSeedUser("A", "MANAGER");
    const initial = (await poll()).body as Board;
    expect(((await poll({ since: initial.serverTime })).body as Board).items).toEqual([]);

    const target = initial.items.find((order) => order.status === "NEW");
    expect(target, "the seed has a NEW order").toBeTruthy();
    dataOf(await invokeAction(updateOrderStatusAction, { orderId: String(target!.id), status: "ACCEPTED" }));

    const delta = (await poll({ since: initial.serverTime })).body as Board;
    expect(delta.items.map((order) => order.id)).toEqual([target!.id]);
    expect(delta.items[0]).toMatchObject({ status: "ACCEPTED" });

    // Cancelling is a terminal move and still reaches the board, so the card can leave the active tabs.
    dataOf(await invokeAction(updateOrderStatusAction, { orderId: String(target!.id), status: "CANCELLED", reason: "Guest changed their mind" }));
    const afterCancel = (await poll({ since: delta.serverTime })).body as Board;
    expect(afterCancel.items.find((order) => order.id === target!.id)).toMatchObject({ status: "CANCELLED" });
  });

  it("applies the kitchen projection for KITCHEN and never searches a customer name for that role", async () => {
    await asSeedUser("A", "KITCHEN");
    const board = (await poll()).body as Board;
    expect(board.items.length).toBeGreaterThan(0);
    for (const order of board.items) {
      expect(order.customerName).toBeNull();
      expect(order.totalAmount).toBeNull();
      expect(order.paymentStatus).toBeNull();
    }

    // A customer name is not an oracle for the kitchen: searching one matches nothing.
    const withCustomer = await db.order.findFirstOrThrow({
      where: { tenantId: A, status: { in: ["NEW", "ACCEPTED", "PREPARING", "READY"] }, customerId: { not: null } },
      select: { customer: { select: { fullName: true } } },
    });
    const customer = withCustomer.customer!;
    expect(((await poll({ q: customer.fullName })).body as Board).items).toEqual([]);

    await asSeedUser("A", "MANAGER");
    const asManager = (await poll({ q: customer.fullName })).body as Board;
    expect(asManager.items.length).toBeGreaterThan(0);
    expect(asManager.items.every((order) => order.customerName === customer.fullName)).toBe(true);
  });

  it("caps a page, reports hasMore and refuses an out-of-range or unknown filter", async () => {
    await asSeedUser("A", "MANAGER");
    const page = (await poll({ limit: "1" })).body as Board;
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    expect((await poll({ limit: "500" })).status).toBe(422);
    expect((await poll({ status: "NOT_A_STATUS" })).status).toBe(422);
    expect((await poll({ tenantId: tenantIdOf("B") })).status).toBe(422);

    asAnonymous();
    expect((await poll()).status).toBe(401);
  });

  it("never shows another tenant's orders (TI-022)", async () => {
    const aIds = new Set((await db.order.findMany({ where: { tenantId: A }, select: { id: true } })).map((order) => order.id));
    const bCount = await db.order.count({ where: { tenantId: tenantIdOf("B") } });
    expect(bCount).toBeGreaterThan(0);

    await asSeedUser("A", "MANAGER");
    const board = (await poll({ limit: "200" })).body as Board;
    for (const order of board.items) expect(aIds.has(String(order.id))).toBe(true);
  });
});

describe("TC-ORDER-011 detail allowed actions", () => {
  const sorted = (actions: readonly OrderAction[]) => [...actions].sort();

  it("differ correctly for MANAGER, CASHIER, WAITER and KITCHEN on the same accepted order", async () => {
    const orderId = seeded("A", "order:o2");
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("ACCEPTED");

    await asSeedUser("A", "MANAGER");
    const manager = dataOf(await invokeAction(detailAction, orderId));
    expect(sorted(manager.allowedActions)).toEqual(sorted(["PREPARING", "CANCELLED", "SET_PRIORITY", "SET_HIGH_PRIORITY", "SET_CUSTOMER"]));

    // A cashier may not push an accepted order along the kitchen flow, nor cancel it after acceptance (Q-008 B).
    await asSeedUser("A", "CASHIER");
    const cashier = dataOf(await invokeAction(detailAction, orderId));
    expect(sorted(cashier.allowedActions)).toEqual(sorted(["SET_PRIORITY", "SET_HIGH_PRIORITY", "SET_CUSTOMER"]));

    // A waiter holds `order:update_meta` but may not mark an order urgent (api.md SA-ORD-06).
    await asSeedUser("A", "WAITER");
    const waiter = dataOf(await invokeAction(detailAction, orderId));
    expect(sorted(waiter.allowedActions)).toEqual(sorted(["SET_PRIORITY", "SET_CUSTOMER"]));

    await asSeedUser("A", "KITCHEN");
    const kitchen = dataOf(await invokeAction(detailAction, orderId));
    expect(sorted(kitchen.allowedActions)).toEqual(["PREPARING"]);
    expect(kitchen.order.customer).toBeNull();
    expect(kitchen.order.totalAmount).toBeNull();
    expect(kitchen.order.paymentStatus).toBeNull();
    expect(kitchen.order.lines.every((line) => line.lineTotal === null)).toBe(true);
    expect(kitchen.canSeeMoney).toBe(false);
  });

  it("carries the order's own snapshots, tickets and activity, and is NOT_FOUND across tenants (TI-023)", async () => {
    await asSeedUser("A", "MANAGER");
    const detail = dataOf(await invokeAction(detailAction, seeded("A", "order:o3")));
    expect(detail.order.lines.length).toBeGreaterThan(0);
    expect(detail.order.kots.length).toBeGreaterThan(0);
    expect(detail.timeline.length).toBeGreaterThan(0);
    expect(detail.order.lines.some((line) => line.specialInstructions !== null)).toBe(true);
    expect(detail.order.lines.some((line) => line.addons.length > 0)).toBe(true);
    expect(detail.canSeeMoney).toBe(true);

    expectSameNotFound(await invokeAction(detailAction, seeded("B", "order:o1")), await invokeAction(detailAction, RANDOM_UUID));
  });
});
