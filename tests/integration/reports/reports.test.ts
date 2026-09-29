import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAnalyticsAction } from "@/app/restaurant/analytics/actions";
import DashboardPage from "@/app/restaurant/dashboard/page";
import ReportsPage from "@/app/restaurant/reports/page";
import { requireTenant } from "@/lib/auth/guards";
import { salesSummary } from "@/lib/data/reports";
import type { ActionResult } from "@/lib/http/action";
import { fixedClock, overrideClock } from "@/lib/time";
import { formatBusinessDate, formatMoney } from "@/lib/ui/format";
import { testDb } from "../setup/db";
import { SEED_NOW, asSeedUser, invokeAction, invokeLoader, seedOnce, tenantIdOf, type ControlFlow, type TenantKey } from "../helpers/actors";

// Reports, analytics and dashboard aggregates retrofit (S1-P04-T007): `report:read` / `dashboard:read`
// (security.md §3.3 rows 8 and 48), tenant-scoped SQL aggregates over restaurant business dates, Decimal money.
// Replaces the analytics half of the mocked tests/unit/social-analytics.test.ts.
const db = testDb();
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

// Seed "now": 14:00 in Kolkata (Tenant A) and 04:30 in New York (Tenant B), both on business date 2026-09-15.
const TODAY = "2026-09-15";
const YESTERDAY = "2026-09-14";
const WEEK_START = "2026-09-09";
let restoreClock: () => void = () => {};

/** Amounts render through Intl with the restaurant currency, exactly as the pages do (ADR-010 §1). */
const money = (amount: string) => formatMoney(amount, "INR");

beforeAll(async () => {
  await seedOnce();
  restoreClock = overrideClock(fixedClock(SEED_NOW.toISOString()));
}, 120_000);
afterAll(() => restoreClock());

function dataOf<T>(result: ActionResult<T> | ControlFlow): T {
  if (!("ok" in result) || !result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
  return result.data;
}

/** Independent computation from rows (not SQL SUM): BR-RPT-01 as documented in api.md §15. */
async function direct(tenant: TenantKey, from: string | null, to: string | null) {
  const tenantId = tenantIdOf(tenant);
  const dates = from && to ? { businessDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } : {};
  const orders = await db.order.findMany({ where: { tenantId, ...dates }, select: { status: true, totalAmount: true } });
  const sales = orders.filter((o) => o.status === "COMPLETED" || o.status === "REFUNDED");
  const refunds = await db.transaction.findMany({ where: { tenantId, type: "REFUND", status: "SUCCESS", ...dates }, select: { amount: true } });
  const gross = sales.reduce((sum, o) => sum.add(o.totalAmount), D(0));
  const refund = refunds.reduce((sum, t) => sum.add(t.amount), D(0));
  return {
    gross: gross.toFixed(2),
    refunds: refund.toFixed(2),
    net: gross.sub(refund).toFixed(2),
    salesCount: sales.length,
    orderCount: orders.length,
    completed: orders.filter((o) => o.status === "COMPLETED").length,
    cancelled: orders.filter((o) => o.status === "CANCELLED").length,
    aov: sales.length ? gross.div(sales.length).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) : "0.00",
  };
}

type ElementLike = { type: unknown; props: Record<string, unknown> };
const isElement = (node: unknown): node is ElementLike => typeof node === "object" && node !== null && "props" in node && "type" in node;

/**
 * Props that carry styling or wiring rather than anything a person reads. Without this the walker below would fold
 * every `className` into the page text, and an assertion could pass on a Tailwind class that happens to contain the
 * string it was looking for.
 */
const NON_TEXT_PROPS = new Set(["className", "style", "key", "ref", "id", "href", "src", "type", "name", "role", "target", "rel", "icon", "hue", "testId"]);
const isTextProp = (key: string) => !NON_TEXT_PROPS.has(key) && !key.startsWith("aria-") && !key.startsWith("data-") && !key.startsWith("on");

/**
 * Concatenated text of a React element tree returned by a Server Component (no rendering needed).
 *
 * Walks every content-bearing prop, not just `children`. A Server Component tree hands text to a child through
 * whichever prop that child names, and `MetricCard` takes its figure as `value` and its caption as `support`. While
 * this only followed `children`, the page's own numbers were invisible here, so three assertions failed against a
 * page that was rendering them correctly [f12a53a moved the dashboard and reports figures into those props].
 */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isElement(node)) return "";
  return Object.entries(node.props)
    .filter(([key]) => isTextProp(key))
    .map(([, value]) => textOf(value))
    .join("");
}

function findTestId(node: unknown, id: string): ElementLike | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTestId(child, id);
      if (found) return found;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (node.props["data-testid"] === id) return node;
  return findTestId(node.props.children, id);
}

const searchParams = (params: Record<string, string> = {}) => ({ searchParams: Promise.resolve(params) });

describe("analytics action (report:read)", () => {
  it("TC-RBAC-148 CASHIER, WAITER and KITCHEN are FORBIDDEN", async () => {
    for (const role of ["CASHIER", "WAITER", "KITCHEN"] as const) {
      await asSeedUser("A", role);
      expect(await invokeAction(getAnalyticsAction, { timeframe: "30d" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("TI-048 MANAGER's figures for today equal a direct Decimal sum over Tenant A's orders and never include Tenant B", async () => {
    await asSeedUser("A", "MANAGER");
    const analytics = dataOf(await invokeAction(getAnalyticsAction, { timeframe: "today" }));
    const [a, b] = [await direct("A", TODAY, TODAY), await direct("B", TODAY, TODAY)];
    expect(D(a.gross).gt(0) && D(b.gross).gt(0)).toBe(true);
    expect(analytics).toMatchObject({
      range: { from: TODAY, to: TODAY },
      currencyCode: "INR",
      grossRevenue: a.gross,
      netRevenue: a.net,
      totalOrders: a.salesCount,
      averageOrderValue: a.aov,
    });
    expect(analytics.grossRevenue).not.toBe(D(a.gross).add(b.gross).toFixed(2));
  });

  it("TI-048 the all-time figures and best sellers are Tenant A's only", async () => {
    await asSeedUser("A", "MANAGER");
    const analytics = dataOf(await invokeAction(getAnalyticsAction, { timeframe: "all" }));
    const a = await direct("A", null, null);
    expect(analytics).toMatchObject({ range: null, grossRevenue: a.gross, totalOrders: a.salesCount });

    const lines = await db.orderItem.findMany({
      where: { tenantId: tenantIdOf("A"), order: { status: { in: ["COMPLETED", "REFUNDED"] } } },
      select: { itemNameSnapshot: true, quantity: true, lineSubtotal: true },
    });
    const byName = new Map<string, { quantity: number; revenue: Prisma.Decimal }>();
    for (const l of lines) {
      const entry = byName.get(l.itemNameSnapshot) ?? { quantity: 0, revenue: D(0) };
      byName.set(l.itemNameSnapshot, { quantity: entry.quantity + l.quantity, revenue: entry.revenue.add(l.lineSubtotal) });
    }
    const top = analytics.topMenuItems;
    expect(top).toHaveLength(Math.min(5, byName.size));
    for (const item of top) {
      expect(byName.get(item.name), item.name).toBeDefined();
      expect(item).toEqual({ name: item.name, quantity: byName.get(item.name)!.quantity, revenue: byName.get(item.name)!.revenue.toFixed(2) });
    }
    const quantities = top.map((i) => i.quantity);
    expect(quantities).toEqual([...quantities].sort((x, y) => y - x));
    // Nothing left out sold more than the last item shown (ties may be ordered by collation).
    const shown = new Set(top.map((i) => i.name));
    const omittedMax = Math.max(0, ...[...byName.entries()].filter(([name]) => !shown.has(name)).map(([, v]) => v.quantity));
    expect(omittedMax).toBeLessThanOrEqual(quantities[quantities.length - 1] ?? 0);
  });

  it("TC-TZ ranges follow the restaurant's timezone, not UTC: at 00:30 Kolkata Tenant A's 'today' is a new, empty day", async () => {
    const restore = overrideClock(fixedClock("2026-09-15T19:00:00.000Z")); // 00:30 on 16 Sep in Kolkata, 15:00 on 15 Sep in New York
    try {
      await asSeedUser("A", "MANAGER");
      const a = dataOf(await invokeAction(getAnalyticsAction, { timeframe: "today" }));
      expect(a).toMatchObject({ range: { from: "2026-09-16", to: "2026-09-16" }, grossRevenue: "0.00", totalOrders: 0 });

      await asSeedUser("B", "MANAGER");
      const b = dataOf(await invokeAction(getAnalyticsAction, { timeframe: "today" }));
      expect(b).toMatchObject({ range: { from: TODAY, to: TODAY }, currencyCode: "USD", grossRevenue: (await direct("B", TODAY, TODAY)).gross });
    } finally {
      restore();
    }
  });

  it("ADV-001 rejects a tenantId or an unknown timeframe (422)", async () => {
    await asSeedUser("A", "MANAGER");
    expect(await invokeAction(getAnalyticsAction, { timeframe: "7d", tenantId: tenantIdOf("B") } as never)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(await invokeAction(getAnalyticsAction, { timeframe: "1y" } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("reports page and data (report:read)", () => {
  it("TC-RBAC-148 the reports page redirects CASHIER, WAITER and KITCHEN to /account/forbidden", async () => {
    for (const role of ["CASHIER", "WAITER", "KITCHEN"] as const) {
      await asSeedUser("A", role);
      expect(await invokeLoader(ReportsPage, searchParams())).toEqual({ redirect: "/account/forbidden" });
    }
  });

  it("TI-048 sales summary equals direct Decimal sums over Tenant A's orders for the range and excludes Tenant B", async () => {
    await asSeedUser("A", "MANAGER");
    const ctx = await requireTenant("report:read");
    const summary = await salesSummary(ctx, { from: WEEK_START, to: TODAY });
    const [a, b] = [await direct("A", WEEK_START, TODAY), await direct("B", WEEK_START, TODAY)];
    expect(summary).toMatchObject({
      grossSales: a.gross,
      refunds: a.refunds,
      netSales: a.net,
      salesOrderCount: a.salesCount,
      orderCount: a.orderCount,
      completedCount: a.completed,
      cancelledCount: a.cancelled,
      averageOrderValue: a.aov,
    });
    expect(D(b.gross).gt(0)).toBe(true);
    expect(summary.grossSales).not.toBe(D(a.gross).add(b.gross).toFixed(2));
    const typeTotals = Object.values(summary.byOrderType).reduce((sum, t) => sum.add(t.total), D(0));
    expect(typeTotals.toFixed(2)).toBe(a.gross);
  });

  it("the page defaults to the last 7 business days in the restaurant's timezone and shows Tenant A's totals", async () => {
    await asSeedUser("A", "MANAGER");
    const page = await invokeLoader(ReportsPage, searchParams());
    const text = textOf(page);
    const a = await direct("A", WEEK_START, TODAY);
    expect(text).toContain(`Business dates ${WEEK_START} to ${TODAY} (Asia/Kolkata)`);
    expect(text).toContain(money(a.gross));
    expect(text).toContain(`${a.completed} / ${a.orderCount}`);
  });

  it("ADV-001 reads only from/to from the URL: a tenantId query is ignored and an invalid range falls back to the default", async () => {
    await asSeedUser("A", "MANAGER");
    const yesterday = await direct("A", YESTERDAY, YESTERDAY);
    const text = textOf(await invokeLoader(ReportsPage, searchParams({ from: YESTERDAY, to: YESTERDAY, tenantId: tenantIdOf("B") })));
    expect(text).toContain(`Business dates ${YESTERDAY} to ${YESTERDAY}`);
    expect(text).toContain(money(yesterday.gross));

    const reversed = textOf(await invokeLoader(ReportsPage, searchParams({ from: TODAY, to: "2026-09-01" })));
    expect(reversed).toContain(`Business dates ${WEEK_START} to ${TODAY}`);
  });
});

describe("dashboard (restaurant:read, aggregates only with dashboard:read)", () => {
  it("renders for CASHIER, KITCHEN and WAITER without any sales aggregates", async () => {
    for (const role of ["CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      const page = await invokeLoader(DashboardPage);
      expect(page).not.toHaveProperty("redirect");
      expect(findTestId(page, "dashboard-sales-today"), role).toBeNull();
      expect(textOf(page)).not.toContain("Net sales today");
    }
  });

  it("TI-047 shows MANAGER and TENANT_ADMIN today's Tenant A figures (restaurant business date), excluding Tenant B", async () => {
    const a = await direct("A", TODAY, TODAY);
    for (const role of ["MANAGER", "TENANT_ADMIN"] as const) {
      await asSeedUser("A", role);
      const page = await invokeLoader(DashboardPage);
      const section = findTestId(page, "dashboard-sales-today");
      expect(section, role).not.toBeNull();
      const text = textOf(section);
      expect(text).toContain(money(a.net));
      expect(text).toContain(money(a.aov));
      // The business date lives in the dashboard context header, above the metric row, written for people.
      expect(textOf(page)).toContain(formatBusinessDate(TODAY));
    }
  });
});
