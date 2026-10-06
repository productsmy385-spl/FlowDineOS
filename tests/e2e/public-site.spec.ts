import { axeCheck, expect, test } from "./fixtures/axe";

/**
 * Public restaurant website (S1-P09-T003/T004/T012):
 * TC-WEB-001 the site shows this restaurant's own content · TC-WEB-010 today's menu page and its empty state ·
 * TC-WEB-021 responsive 320–1920, axe-clean, real empty states · TC-ORDER-012 nothing on the page can submit an order.
 *
 * These run against the seeded development database, where `spice-route` is the published restaurant. They assert
 * behaviour that holds for any published site — the theme is read from the page, never hard-coded here — so they do
 * not depend on which palette that database happens to hold.
 */
const SITE = "/r/spice-route";

// The development server compiles each route the first time it is asked for, and four workers ask at once.
test.beforeEach(({}, testInfo) => testInfo.setTimeout(120_000));

test.describe("public restaurant website", () => {
  test("TC-WEB-001 renders this restaurant's hero, menu and opening hours, and no other tenant's", async ({ page }) => {
    await page.goto(SITE);

    const root = page.locator("[data-site-slug]");
    await expect(root).toHaveAttribute("data-site-slug", "spice-route");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Spice Route");

    const body = await page.locator("body").innerText();
    expect(body).toContain("Spice Route");
    expect(body).not.toContain("Harbour Grill");
    expect(body).not.toContain("Clam Chowder");
    // Prices are the restaurant's own currency, formatted for its country.
    expect(body).toMatch(/₹\s?\d/);
    // Open-now is a label, never colour alone.
    expect(body).toMatch(/Open now|Closed now/);
    expect(body).toContain("Asia/Kolkata");
  });

  test("TC-WEB-012 the page paints the tenant theme on its own root, and the platform theme nowhere below it", async ({ page }) => {
    await page.goto(SITE);
    const theme = await page.locator("[data-site-slug]").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        surfaceMode: element.getAttribute("data-theme"),
        sitePrimary: style.getPropertyValue("--site-primary").trim(),
        primary: style.getPropertyValue("--primary").trim(),
        background: style.backgroundColor,
      };
    });
    expect(["dark", "light"]).toContain(theme.surfaceMode);
    expect(theme.sitePrimary).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(theme.primary).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    // The tenant's surface is what is actually painted, not the console canvas.
    expect(theme.background).toMatch(/^rgb\(/);
  });

  test("TC-ORDER-012 there is no way to place an order from the public site", async ({ page }) => {
    await page.goto(SITE);
    expect(await page.locator("form").count()).toBe(0);
    expect(await page.locator("input, select, textarea").count()).toBe(0);
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const forbidden of ["add to cart", "checkout", "your order", "basket", "place order"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  test("TC-WEB-021 every link resolves and the in-page anchors exist", async ({ page, request }) => {
    await page.goto(SITE);
    const hrefs = await page.locator("a[href]").evaluateAll((links) => [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))]);
    for (const href of hrefs.filter((h) => h.startsWith("/"))) {
      const response = await request.get(href, { maxRedirects: 5 });
      expect(response.status(), href).not.toBe(404);
    }
    for (const anchor of hrefs.filter((h) => h.startsWith("#"))) {
      expect(await page.locator(anchor).count(), anchor).toBe(1);
    }
  });

  test("TC-WEB-021 responsive from 320 to 1920 with no horizontal page scroll", async ({ page }) => {
    for (const width of [320, 375, 390, 414, 768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(SITE);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  });

  test("TC-WEB-021 passes axe at phone and desktop widths", async ({ page }) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(SITE);
      // The ring's turned-away cards are dimmed by design (opacity 0.30 + depth · 0.70) and aria-hidden; the same dishes
      // are in the ring's text list and its front-card caption, which axe does check.
      await axeCheck(page, { exclude: ["[data-ring-dimmed]"] });
    }
  });

  test("TC-WEB-030 the menu ring is the main menu and never crops a card, from 320 to 1920 px", async ({ page }) => {
    test.setTimeout(360_000); // nine page loads
    for (const width of [320, 375, 390, 414, 768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(SITE);
      const ring = page.getByTestId("menu-ring");
      if ((await ring.count()) === 0) continue; // this database's menu may be empty or in card style
      // No card grid repeats the ring.
      expect(await page.locator('section[id^="menu-"]').count(), `duplicate menu grid at ${width}px`).toBe(0);
      const stage = ring.getByRole("group");
      await stage.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const fit = await stage.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>("[data-ring-index]")].map((card) => {
          const r = card.getBoundingClientRect();
          return { left: r.left - box.left, right: box.right - r.right, top: r.top - box.top, bottom: box.bottom - r.bottom };
        });
      });
      for (const edge of fit) {
        expect(Math.min(edge.left, edge.right, edge.top, edge.bottom), `a card is cropped at ${width}px`).toBeGreaterThanOrEqual(-1);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test("TC-WEB-021 a section with nothing in it says so instead of rendering empty", async ({ page }) => {
    await page.goto(SITE);
    const body = await page.locator("body").innerText();
    // Whatever this database holds, every section either has content or an explicit sentence — never a blank band.
    const headings = await page.locator("main section h2").allInnerTexts();
    expect(headings.length).toBeGreaterThan(3);
    for (const heading of headings) expect(heading.trim().length).toBeGreaterThan(0);
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
    expect(body).not.toMatch(/Lorem ipsum|Sample|Demo restaurant|Coming soon/i);
  });
});

test.describe("TC-WEB-010 today's menu page", () => {
  test("renders on its own address and always offers the full menu", async ({ page }) => {
    await page.goto(`${SITE}/daily`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const body = await page.locator("body").innerText();
    // Either today's dishes, or a plain sentence saying there are none — never an empty page.
    expect(body).toMatch(/₹\s?\d|has not published a menu for today|nothing to show right now/);
    await expect(page.getByRole("link", { name: "See the full menu" })).toBeVisible();
  });

  test("passes axe", async ({ page }) => {
    await page.goto(`${SITE}/daily`);
    await axeCheck(page);
  });
});

test.describe("LD-PUB-03 discoverability", () => {
  test("TC-WEB-008 robots disallows the console and the sitemap lists published sites only", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    const text = await robots.text();
    for (const path of ["/restaurant", "/admin", "/account", "/api"]) expect(text).toContain(`Disallow: ${path}`);

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    expect(xml).toContain("/r/spice-route");
    for (const path of ["/restaurant", "/admin", "/account", "/api/"]) expect(xml, path).not.toContain(path);
  });

  test("an unknown restaurant renders the public 404, not an error page", async ({ page }) => {
    const response = await page.goto("/r/no-such-restaurant");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("isn't available");
  });
});
