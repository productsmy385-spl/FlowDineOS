import { beforeAll, describe, expect, it } from "vitest";
import KitchenPage from "@/app/restaurant/kitchen/page";
import KdsRedirectPage from "@/app/restaurant/kds/page";
import OrdersPage from "@/app/restaurant/orders/page";
import { updateKOTStatusAction } from "@/app/restaurant/kitchen/actions";
import { KitchenBoard } from "@/components/kitchen/kitchen-board";
import { lateness } from "@/components/kitchen/kot-card";
import { OrderBoard } from "@/components/orders/order-board";
import { kitchenBoard } from "@/lib/data/kitchen";
import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, invokeLoader, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { requireComponent } from "../menu/ui-tree";
import { dataOf, errorOf } from "../orders/helpers";

/**
 * TC-KITCH-003 / TC-KITCH-005 as integration tests (testing.md §2: the console has no authenticated e2e path here).
 *
 * The board is driven through its loader, so the assertions are on what the server actually resolved: which tickets
 * a section filter returns, which moves the role may make, and — for TC-KITCH-005 — that the order board follows the
 * kitchen from PREPARING to READY without anyone touching the order directly.
 */
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

/** LD-KOT-01 with a section filter, called exactly as the board's poll would. */
const sectionBoard = action(async (sectionId: string) => {
  const ctx = await requireTenant("kot:read");
  return kitchenBoard(ctx, { sectionId });
});

describe("TC-KITCH-003 section selection", () => {
  it("shows only the chosen section's tickets, and offers the tenant's own sections", async () => {
    await asSeedUser("A", "KITCHEN");
    const page = await invokeLoader(KitchenPage);
    const board = requireComponent<React.ComponentProps<typeof KitchenBoard>>(page, KitchenBoard, "KitchenBoard");

    expect(board.initial.tickets.length).toBeGreaterThan(0);
    expect(board.sections.map((section) => section.code).sort()).toEqual(["BAR", "MAIN", "TANDOOR"]);
    expect(board.timezone).toBe("Asia/Kolkata");

    const tandoor = await db.kitchenSection.findFirstOrThrow({ where: { tenantId: A, code: "TANDOOR" } });
    const filtered = dataOf(await invokeAction(sectionBoard, tandoor.id));
    expect(filtered.tickets.every((ticket) => ticket.sectionId === tandoor.id)).toBe(true);

    // Another tenant's section id simply matches nothing (TI-037).
    const foreign = await db.kitchenSection.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    expect(dataOf(await invokeAction(sectionBoard, foreign.id)).tickets).toEqual([]);
  });

  it("gives each role only the moves it may make, and keeps customer and money off the board", async () => {
    await asSeedUser("A", "KITCHEN");
    const kitchen = requireComponent<React.ComponentProps<typeof KitchenBoard>>(await invokeLoader(KitchenPage), KitchenBoard, "KitchenBoard");
    expect([...kitchen.allowedTargets].sort()).toEqual(["PREPARING", "READY", "SERVED"]);

    // A waiter may only serve what the kitchen has finished (security.md §3.4).
    await asSeedUser("A", "WAITER");
    const waiter = requireComponent<React.ComponentProps<typeof KitchenBoard>>(await invokeLoader(KitchenPage), KitchenBoard, "KitchenBoard");
    expect(waiter.allowedTargets).toEqual(["SERVED"]);

    const payload = JSON.stringify(waiter.initial);
    expect(payload).not.toMatch(/customer|phone|email|amount|price|total|paid/i);
  });

  it("the baseline `/restaurant/kds` route forwards to the one board", async () => {
    await asSeedUser("A", "KITCHEN");
    expect(await invokeLoader(KdsRedirectPage)).toEqual({ redirect: "/restaurant/kitchen" });
  });
});

describe("TC-KITCH-005 kitchen moves the order", () => {
  it("Start then Ready, then a waiter serves — and the order board follows", async () => {
    const orderId = seeded("A", "order:o2");
    const ticket = await db.kotTicket.findFirstOrThrow({ where: { tenantId: A, orderId } });
    expect(ticket.status).toBe("QUEUED");

    const statusOnBoard = async (role: "KITCHEN" | "WAITER" | "MANAGER") => {
      await asSeedUser("A", role);
      const board = requireComponent<React.ComponentProps<typeof OrderBoard>>(await invokeLoader(OrdersPage, { searchParams: Promise.resolve({ view: "all" }) }), OrderBoard, "OrderBoard");
      return board.initial.items.find((order) => order.id === orderId)?.status;
    };

    expect(await statusOnBoard("MANAGER")).toBe("ACCEPTED");

    await asSeedUser("A", "KITCHEN");
    expect(dataOf(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "PREPARING" })).status).toBe("PREPARING");
    expect(await statusOnBoard("MANAGER")).toBe("PREPARING");

    await asSeedUser("A", "KITCHEN");
    expect(dataOf(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "READY" })).status).toBe("READY");
    expect(await statusOnBoard("MANAGER")).toBe("READY");

    // Starting a ticket is the kitchen's move: a waiter holds `kot:serve` but not `kot:update_status`.
    await asSeedUser("A", "WAITER");
    expect(errorOf(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "PREPARING" })).code).toBe("FORBIDDEN");

    // Serving is the move every floor role may make (security.md §3.3 row 26).

    expect(dataOf(await invokeAction(updateKOTStatusAction, { kotId: ticket.id, toStatus: "SERVED" })).status).toBe("SERVED");

    // A served ticket leaves the working board.
    await asSeedUser("A", "KITCHEN");
    const board = requireComponent<React.ComponentProps<typeof KitchenBoard>>(await invokeLoader(KitchenPage), KitchenBoard, "KitchenBoard");
    expect(board.initial.tickets.map((entry) => entry.id)).not.toContain(ticket.id);
  });
});

describe("TC-KITCH-007 lateness thresholds", () => {
  it("warns at the target prep time and reads overdue at +50 %", () => {
    expect(lateness(9, 10)).toBe("ontime");
    expect(lateness(10, 10)).toBe("warning");
    expect(lateness(14, 10)).toBe("warning");
    expect(lateness(15, 10)).toBe("overdue");
    // A ticket whose items declare no preparation time is never called late.
    expect(lateness(120, null)).toBe("ontime");
  });
});
