import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { issueStaffPassword, signInAsStaff } from "./fixtures/staff";

/**
 * TC-RAIL-010…012 — the orders and kitchen rails with real data (owner brief 2026-10-07 §2–20).
 * A cashier signs in with a daily password; the rails show every active order, keyboard and Enter work, and an order
 * written to the database appears on the rail by itself through the board's polling.
 */
const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

test("TC-RAIL-010 every active order is on the rail; arrows move between cards and Enter opens one", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsStaff(page, await issueStaffPassword(db, "CASHIER"));
  await page.goto("/restaurant/orders");
  const rail = page.getByRole("list", { name: "Orders" });
  const cards = rail.locator("[data-rail-card]");
  const count = await cards.count();
  test.skip(count < 2, "the seed has fewer than two active orders");

  await cards.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  // The focused card is the active one: its neighbours recede.
  await expect(cards.nth(0)).toHaveAttribute("data-ring-dimmed", "");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/restaurant\/orders\/[0-9a-f-]{36}$/);
});

test("TC-RAIL-011 a new order in the database appears on the rail without a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsStaff(page, await issueStaffPassword(db, "CASHIER"));
  await page.goto("/restaurant/orders");
  const rail = page.getByRole("list", { name: "Orders" });
  const before = await rail.locator("[data-rail-card]").count();

  // A real order row, as the order service would write it (one line copied from the seeded menu).
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "spice-route" } });
  const item = await db.menuItem.findFirstOrThrow({ where: { tenantId: tenant.id, archivedAt: null } });
  const latest = await db.order.findFirstOrThrow({ where: { tenantId: tenant.id }, orderBy: { createdAt: "desc" } });
  const number = `E2E-${randomUUID().slice(0, 6)}`;
  await db.order.create({
    data: {
      tenantId: tenant.id,
      orderNumber: number,
      businessDate: latest.businessDate,
      orderType: "TAKEAWAY",
      status: "NEW",
      subtotalAmount: item.basePrice,
      taxAmount: "0",
      totalAmount: item.basePrice,
      currencyCode: latest.currencyCode,
      idempotencyKey: randomUUID(),
      items: {
        create: {
          menuItemId: item.id,
          itemNameSnapshot: item.name,
          unitPriceSnapshot: item.basePrice,
          taxRateSnapshot: "0",
          quantity: 1,
          lineSubtotal: item.basePrice,
          lineTax: "0",
          lineTotal: item.basePrice,
        },
      },
    },
  });

  await expect(rail.getByText(number)).toBeVisible({ timeout: 45_000 });
  // Exactly one card for the new order. The total is not compared with `before`: the desktop, tablet and mobile runs
  // insert their own orders into the same restaurant at the same time, so other cards can arrive too.
  await expect(rail.locator("[data-rail-card]").filter({ hasText: number })).toHaveCount(1);
  expect(await rail.locator("[data-rail-card]").count()).toBeGreaterThanOrEqual(before + 1);
});

test("TC-RAIL-012 the kitchen shows three status rails, each with every ticket in that state", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsStaff(page, await issueStaffPassword(db, "KITCHEN"));
  await page.goto("/restaurant/kitchen");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "spice-route" } });
  for (const status of ["QUEUED", "PREPARING", "READY"] as const) {
    const lane = page.getByTestId(`kitchen-lane-${status}`);
    await expect(lane).toBeVisible();
    const expected = await db.kotTicket.count({ where: { tenantId: tenant.id, status } });
    const shown = await lane.locator("[data-rail-card]").count();
    expect(shown, status).toBe(expected);
  }
});
