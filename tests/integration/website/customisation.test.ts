import type { Prisma } from "@prisma/client";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import PublicRestaurantPage from "@/app/r/[slug]/page";
import RestaurantDashboardPage from "@/app/restaurant/dashboard/page";
import WebsiteSettingsPage from "@/app/restaurant/website/page";
import { getWebsiteSettingsAction, saveWebsiteSectionsAction, updateWebsiteIdentityAction, updateWebsiteThemeAction } from "@/app/restaurant/website/actions";
import { channels } from "@/components/public/theme";
import { freezeTime, testDb } from "../setup/db";
import { SEED_NOW, asAnonymous, asSeedUser, invokeAction, invokeLoader, seedOnce, tenantIdOf } from "../helpers/actors";

/**
 * TC-WEB-017 — a TENANT_ADMIN changes a colour and a section headline; the public site shows it and the console does
 * not (S1-P07-T011, ADR-013 §6).
 *
 * The task's test id is written as e2e. There are no Clerk test users in this environment, so an authenticated
 * browser session cannot be driven; the console half is covered here instead, end to end through the real Server
 * Actions, the real guards and the real database — only the browser is missing.
 */
const db = testDb();

const NEW_PRIMARY = "#7DD3FC"; // readable on the dark surface and used by neither tenant's seed
const NEW_HEADLINE = "Dinner on the terrace";

const publicMarkup = async (slug: string): Promise<string> => {
  asAnonymous();
  const element = await invokeLoader(PublicRestaurantPage, { params: Promise.resolve({ slug }) });
  expect(element, slug).not.toEqual({ notFound: true });
  return renderToStaticMarkup(element as ReactElement);
};

type SectionRow = Awaited<ReturnType<typeof db.websiteSection.findMany>>[number];
type RestaurantRow = Awaited<ReturnType<typeof db.restaurant.findMany>>[number];

let seededSections: SectionRow[] = [];
let seededRestaurants: RestaurantRow[] = [];
let unfreeze: (() => void) | null = null;

beforeAll(async () => {
  await seedOnce();
  seededSections = await db.websiteSection.findMany();
  seededRestaurants = await db.restaurant.findMany();
}, 120_000);

beforeEach(async () => {
  await db.restaurant.updateMany({ data: { websitePublished: true } });
  unfreeze = freezeTime(SEED_NOW.toISOString());
});

afterEach(async () => {
  unfreeze?.();
  unfreeze = null;
  await db.websiteSection.deleteMany({});
  await db.websiteSection.createMany({ data: seededSections });
  for (const restaurant of seededRestaurants) {
    const { id, tenantId, createdAt, updatedAt, ...columns } = restaurant;
    void tenantId;
    void createdAt;
    void updatedAt;
    await db.restaurant.update({ where: { id }, data: { ...columns, brandColors: columns.brandColors as Prisma.InputJsonValue } });
  }
});

describe("TC-WEB-017 a saved change reaches the public site and nowhere else", () => {
  it("a new colour and a new hero headline appear on the restaurant's own site", async () => {
    const before = await publicMarkup("spice-route");
    expect(before).not.toContain(NEW_PRIMARY);
    expect(before).not.toContain(NEW_HEADLINE);

    await asSeedUser("A", "TENANT_ADMIN");
    const theme = await invokeAction(updateWebsiteThemeAction, {
      preset: "CUSTOM",
      surfaceMode: "DARK",
      primaryHex: NEW_PRIMARY,
      secondaryHex: "#A5B4FC",
      accentHex: "#FFE066",
    });
    expect(theme).toMatchObject({ ok: true });

    const sections = await invokeAction(saveWebsiteSectionsAction, {
      sections: [{ key: "HERO", enabled: true, sortOrder: 0, headline: NEW_HEADLINE }],
    });
    expect(sections).toMatchObject({ ok: true });

    const after = await publicMarkup("spice-route");
    expect(after).toContain(`--site-primary:${NEW_PRIMARY}`);
    expect(after).toContain(`--primary:${channels(NEW_PRIMARY)}`);
    expect(after).toContain(NEW_HEADLINE);
  });

  it("the other tenant's site is untouched", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    await invokeAction(updateWebsiteThemeAction, { preset: "CUSTOM", surfaceMode: "DARK", primaryHex: NEW_PRIMARY, secondaryHex: "#A5B4FC", accentHex: "#FFE066" });
    await invokeAction(saveWebsiteSectionsAction, { sections: [{ key: "HERO", enabled: true, sortOrder: 0, headline: NEW_HEADLINE }] });

    const other = await publicMarkup("harbour-grill");
    expect(other).not.toContain(NEW_PRIMARY);
    expect(other).not.toContain(NEW_HEADLINE);
  });

  it("the console keeps the platform theme: no tenant colour reaches a console page", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    await invokeAction(updateWebsiteThemeAction, { preset: "CUSTOM", surfaceMode: "LIGHT", primaryHex: "#0369A1", secondaryHex: "#0E7490", accentHex: "#4338CA" });

    await asSeedUser("A", "TENANT_ADMIN");
    const dashboard = renderToStaticMarkup((await invokeLoader(RestaurantDashboardPage)) as ReactElement);
    // The console never re-points a semantic token, and never carries the public site's theme variables.
    expect(dashboard).not.toContain("--site-primary");
    expect(dashboard).not.toContain("--primary:");
    expect(dashboard).not.toContain("data-theme=");
  });

  it("the customisation screen shows the tenant colours only inside its own preview", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const html = renderToStaticMarkup((await invokeLoader(WebsiteSettingsPage)) as ReactElement);
    expect(html).toContain("Colours");
    expect(html).toContain("Sections");
    // Every re-pointed token in the console lives inside the preview element, never on the page itself.
    const previewIndex = html.indexOf("data-preview-preset");
    expect(previewIndex).toBeGreaterThan(-1);
    for (const match of html.matchAll(/--primary:/g)) expect(match.index!).toBeGreaterThan(previewIndex);
  });
});

describe("the customisation screen is wired to the real services", () => {
  it("LD-WEB-01 returns every section, the resolved theme and the caller's edit flag", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await invokeAction(getWebsiteSettingsAction);
    expect(result).toMatchObject({ ok: true });
    const data = (result as { ok: true; data: Record<string, unknown> }).data;
    expect((data.sections as unknown[]).length).toBe(11);
    expect(data.canEdit).toBe(true);
    expect(Object.keys(data.cssVariables as object).every((key) => key.startsWith("--site-"))).toBe(true);
  });

  it("a MANAGER may read the screen but not save: the server refuses every write", async () => {
    await asSeedUser("A", "MANAGER");
    const read = await invokeAction(getWebsiteSettingsAction);
    expect(read).toMatchObject({ ok: true, data: { canEdit: false } });

    for (const write of [
      invokeAction(updateWebsiteThemeAction, { preset: "OCEAN", surfaceMode: "LIGHT" }),
      invokeAction(updateWebsiteIdentityAction, { tagline: "Not allowed" }),
      invokeAction(saveWebsiteSectionsAction, { sections: [{ key: "HERO", enabled: true, sortOrder: 0, headline: "Not allowed" }] }),
    ]) {
      expect(await write).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    expect((await db.restaurant.findUniqueOrThrow({ where: { tenantId: tenantIdOf("A") } })).tagline).toBe("Clay-oven cooking from both coasts");
  });

  it("TC-WEB-014 an unreadable colour is rejected with the measured ratio, and the site does not change", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const result = await invokeAction(updateWebsiteThemeAction, { preset: "CUSTOM", surfaceMode: "DARK", primaryHex: "#111111", secondaryHex: "#A5B4FC", accentHex: "#FFE066" });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    const fieldErrors = (result as { ok: false; error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors;
    expect(fieldErrors?.primaryHex?.[0]).toMatch(/\d+(\.\d+)?:1/);

    const site = await publicMarkup("spice-route");
    expect(site).not.toContain("#111111");
  });
});
