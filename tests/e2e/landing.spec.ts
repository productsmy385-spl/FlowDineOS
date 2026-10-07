import { palette, semanticTokens } from "@/lib/ui/tokens";
import { axeCheck, expect, test } from "./fixtures/axe";

/** "#38BD15" → "rgb(56, 189, 21)", the form `getComputedStyle` returns. */
const asRendered = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

// TC-DS-015 (landing page) and TC-DS-007 (self-hosted fonts), now on Brand v2 (RASOIOS-ADR-013).
test.describe("landing page", () => {
  test("TC-DS-015 every link resolves without a 404", async ({ page, request }) => {
    await page.goto("/");
    const hrefs = await page.locator("a[href]").evaluateAll((links) => [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))]);
    expect(hrefs.length).toBeGreaterThan(2);
    for (const href of hrefs.filter((h) => h.startsWith("/"))) {
      const response = await request.get(href, { maxRedirects: 5 });
      expect(response.status(), href).not.toBe(404);
    }
    for (const anchor of hrefs.filter((h) => h.startsWith("#"))) {
      expect(await page.locator(anchor).count(), anchor).toBe(1);
    }
  });

  test("uses honest licence language and no plan or tier wording", async ({ page }) => {
    await page.goto("/");
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).toContain("no subscription plans");
    for (const forbidden of ["starter plan", "pro plan", "enterprise plan", "per month", "/month", "free trial", "tier"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  test("TC-DS-007 loads no fonts from Google at runtime", async ({ page }) => {
    const googleRequests: string[] = [];
    page.on("request", (r) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) googleRequests.push(r.url());
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(googleRequests).toEqual([]);
  });

  test("paints the Brand v2 palette, not the amber/emerald v1 one", async ({ page }) => {
    await page.goto("/");
    // Read from the tokens rather than pinned literals: the point is that the page paints what `lib/ui/tokens.ts`
    // says, so a deliberate palette change (ADR-018) moves the expectation with it, while a page that drifts off the
    // design system still fails. Only the v1 palette below is hardcoded, because that one must never come back.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(asRendered(semanticTokens.dark.surface));
    // The primary call to action is "Book a Demo" (owner brief 2026-10-07 §25); sign-in stays a quieter link.
    const cta = page.getByRole("main").getByRole("button", { name: "Book a Demo" }).first();
    const style = await cta.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, color: computed.color, height: computed.height };
    });
    expect(style.background).toBe(asRendered(palette.primary[400]));
    expect(style.color).toBe(asRendered(semanticTokens.dark["on-primary"]));
    expect(Number.parseFloat(style.height)).toBeGreaterThanOrEqual(44);
    // The v1 amber CTA must never return, whatever the current palette is.
    expect(style.background).not.toBe("rgb(217, 119, 6)");
  });

  test("the header is a glass-1 surface with an opaque fallback", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header").first();
    const style = await header.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { background: computed.backgroundColor, filter: computed.backdropFilter, position: computed.position };
    });
    expect(style.position).toBe("sticky");
    // design.md §4.6: glass-1 is surface @ 72 % with a 14 px blur, and it is never more transparent than that.
    expect(style.background).toBe("rgba(11, 17, 16, 0.72)");
    expect(style.filter).toContain("blur(14px)");
  });

  test("passes axe", async ({ page }) => {
    await page.goto("/");
    await axeCheck(page);
  });

  test("TC-LAND-002 one contact section, in the footer, with the right details", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator("#contact").count()).toBe(1);
    const contact = page.locator("footer #contact");
    await expect(contact).toContainText("KJS TECH INNOVATIONS");
    await expect(contact).toContainText("4-177/1, Duddukuru");
    await expect(contact).toContainText("534313");
    const phone = page.getByTestId("footer-phone");
    await expect(phone).toHaveText("9390038335");
    await expect(phone).toHaveAttribute("href", "tel:+919390038335");
    for (const email of ["gopalakrishnaeerothu@gmail.com", "jayendrasimhadri@gmail.com", "productsmy385@gmail.com"]) {
      await expect(contact.locator(`a[href="mailto:${email}"]`)).toHaveCount(1);
      // Each address appears once on the page — no duplicate contact block above the footer.
      expect(await page.locator(`a[href="mailto:${email}"]`).count(), email).toBe(1);
    }
  });

  test("TC-DEMO-010 Book a Demo opens the form, validates it and confirms a real request", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("main").getByRole("button", { name: "Book a Demo" }).first().click();
    const form = page.getByTestId("demo-form");
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "Request demo" }).click();
    await expect(form.getByRole("alert")).toBeVisible();

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await form.getByLabel("Your name").fill("Asha Rao");
    await form.getByLabel("Restaurant or business name").fill("E2E Test Kitchen");
    await form.getByLabel("Mobile number").fill("9876543210");
    await form.getByLabel("Email").fill(`demo.${Date.now()}@example.test`);
    await form.getByLabel("City").fill("Rajahmundry");
    await form.getByLabel("Preferred date").fill(tomorrow);
    await form.getByLabel("Preferred time").fill("11:30");
    await form.getByRole("button", { name: "Request demo" }).click();
    await expect(page.getByTestId("demo-confirmation")).toContainText("Your FlowDineOS demo request has been received");
  });
});
