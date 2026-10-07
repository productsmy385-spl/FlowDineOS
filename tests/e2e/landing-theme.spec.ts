import { expect, test } from "@playwright/test";
import { axeCheck } from "./fixtures/axe";

/**
 * TC-THEME-011 — the platform landing page's light/dark switch (owner brief 2026-10-07). A first visit follows the
 * operating system; a choice made with the header toggle survives a reload; both themes pass the WCAG 2.1 AA checks,
 * colour contrast included, across every section of the page.
 */
const theme = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test.describe("TC-THEME-011 landing page theme", () => {
  // The landing page draws WebGL and the accessibility scan covers the whole page: slow under parallel load.
  test.describe.configure({ timeout: 120_000 });
  for (const scheme of ["light", "dark"] as const) {
    test(`a first visit with the system set to ${scheme} opens in ${scheme}, and passes WCAG AA`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto("/");
      expect(await theme(page)).toBe(scheme);
      await axeCheck(page);
      await context.close();
    });
  }

  test("the header toggle switches the theme, and the choice survives a reload", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/");
    const toggle = page.getByRole("banner").getByRole("button", { name: /Change theme/ });
    await expect(toggle).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemcheckbox", { name: "Light" }).or(page.getByRole("menuitemradio", { name: "Light" })).or(page.getByRole("menuitem", { name: "Light" })).first().click();
    expect(await theme(page)).toBe("light");
    await page.reload();
    expect(await theme(page)).toBe("light");
    await context.close();
  });
});
