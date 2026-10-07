import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { axeCheck } from "./fixtures/axe";

/**
 * TC-QRM-010 — the table QR menu in a browser (owner brief 2026-10-07): one rail card per real category, no menu ring,
 * no page-wide horizontal scroll at any width from 320 to 1920 px, a card opens by widening its frame while its photo
 * keeps the same scale (re-cropped, never stretched or enlarged), and the page passes WCAG 2.1 AA.
 */
const db = new PrismaClient();
let url = "";
let tableId = "";
let categoryCount = 0;

test.beforeAll(async () => {
  const tenant = await db.tenant.findFirstOrThrow({ where: { status: "ACTIVE", menuCategories: { some: { isPublished: true, archivedAt: null, items: { some: { isPublished: true, isAvailable: true, archivedAt: null } } } } }, select: { id: true, slug: true } });
  const table = await db.diningTable.create({ data: { tenantId: tenant.id, label: `E2E ${randomBytes(2).toString("hex")}`, publicCode: `e2e${randomBytes(5).toString("hex")}` } });
  tableId = table.id;
  url = `/r/${tenant.slug}/t/${table.publicCode}`;
  categoryCount = await db.menuCategory.count({ where: { tenantId: tenant.id, isPublished: true, archivedAt: null, items: { some: { isPublished: true, isAvailable: true, archivedAt: null } } } });
});

test.afterAll(async () => {
  if (tableId) await db.diningTable.delete({ where: { id: tableId } });
  await db.$disconnect();
});

test.describe("TC-QRM-010 table QR menu", () => {
  test("one card per real category, no ring, and no horizontal page scroll from 320 to 1920 px", async ({ page }) => {
    test.setTimeout(240_000);
    for (const width of [320, 375, 390, 414, 768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await expect(page.getByTestId("table-menu")).toBeVisible();
      expect(await page.getByTestId("menu-ring").count(), `ring at ${width}px`).toBe(0);
      expect(await page.locator(".menu-rail__card").count(), `cards at ${width}px`).toBe(categoryCount);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test("a card opens by widening its frame; its photo is re-cropped, not enlarged; keyboard reaches every card", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    const cards = page.locator(".menu-rail__card");
    test.skip((await cards.count()) < 2, "needs two categories");
    const second = cards.nth(1);
    const before = await second.boundingBox();
    await second.hover();
    await expect(second).toHaveAttribute("data-open", "true");
    await page.waitForTimeout(800);
    const after = await second.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width * 2);
    expect(Math.round(after!.height)).toBe(Math.round(before!.height));
    // With a photo, its drawn scale (object-fit: cover) is the same open as closed.
    const scales = await cards.evaluateAll((all) =>
      all.map((card) => {
        const img = card.querySelector("img");
        const r = card.getBoundingClientRect();
        return img && img.naturalWidth ? Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight) : null;
      }),
    );
    const known = scales.filter((s): s is number => s !== null);
    if (known.length > 1) expect(Math.max(...known) / Math.min(...known)).toBeLessThan(1.05);

    // Keyboard: focus opens a card and the arrow keys move along the rail.
    await cards.first().focus();
    await expect(cards.first()).toHaveAttribute("data-open", "true");
    await page.keyboard.press("ArrowRight");
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("data-open", "true");
  });

  test("passes WCAG 2.1 AA", async ({ page }) => {
    await page.goto(url);
    await axeCheck(page);
  });
});
