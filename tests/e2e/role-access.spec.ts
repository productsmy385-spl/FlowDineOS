import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { issueStaffPassword, signInAsStaff } from "./fixtures/staff";

/**
 * TC-ROLE-010 — kitchen and waiter staff reach only their own work (owner request 2026-10-07). Each signs in with a
 * real daily password; every area outside their role must refuse them (the server redirects to /account/forbidden),
 * and the areas inside it must open.
 */
const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

const CASES = {
  KITCHEN: {
    allowed: ["/restaurant/kitchen", "/restaurant/orders", "/restaurant/menu/items", "/restaurant/daily-menu"],
    refused: ["/restaurant/dashboard", "/restaurant/transactions", "/restaurant/customers", "/restaurant/reports", "/restaurant/staff", "/restaurant/settings", "/restaurant/settings/data", "/restaurant/website", "/restaurant/tables", "/restaurant/audit", "/restaurant/social"],
  },
  WAITER: {
    allowed: ["/restaurant/orders", "/restaurant/customers", "/restaurant/menu/items"],
    refused: ["/restaurant/dashboard", "/restaurant/transactions", "/restaurant/reports", "/restaurant/staff", "/restaurant/settings", "/restaurant/settings/data", "/restaurant/website", "/restaurant/tables", "/restaurant/audit", "/restaurant/printing"],
  },
} as const;

for (const [role, { allowed, refused }] of Object.entries(CASES) as Array<[keyof typeof CASES, (typeof CASES)[keyof typeof CASES]]>) {
  test(`TC-ROLE-010 ${role} opens only its own areas`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await signInAsStaff(page, await issueStaffPassword(db, role));
    for (const path of refused) {
      await page.goto(path);
      await expect(page, `${role} must not open ${path}`).toHaveURL(/\/account\/forbidden/);
    }
    for (const path of allowed) {
      await page.goto(path);
      await expect(page, `${role} should open ${path}`).toHaveURL(new RegExp(`${path.replace(/\//g, "\/")}$`));
    }
  });
}
