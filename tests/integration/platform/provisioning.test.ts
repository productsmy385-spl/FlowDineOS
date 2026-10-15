import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTenantAction, handOverTenantAction, updateTenantAction } from "@/app/admin/actions";
import type { PlatformContext } from "@/lib/auth/context-types";
import { requirePlatform } from "@/lib/auth/guards";
import { inspectTenant } from "@/lib/services/platform-tenants";
import { getPublicSite } from "@/lib/services/website-theme";
import { RESERVED_HOST_LABELS } from "@/lib/tenancy/hostnames";
import { WEBSITE_SECTION_DEFAULTS, WEBSITE_SECTION_KEYS } from "@/lib/validation/website";
import { testDb } from "../setup/db";
import { actorState } from "../helpers/actor-state";
import { asPlatformAdmin, asSeedUser, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { dataOf, errorOf } from "../orders/helpers";
import { APP_URL, newTenantInput, platformSnapshot, resetClerkStub, startClerkStub, stopClerkStub, xminOf } from "./helpers";

vi.mock("@/lib/auth/clerk-admin", async (importOriginal) => {
  const { stubbedClerkAdminModule } = await import("./helpers");
  return stubbedClerkAdminModule(await importOriginal());
});

// S1-P06-T009 — provisioning and handover (ADR-012 §4, ADR-013 §7):
// TC-ADMIN-013 a new tenant is a working, themed restaurant; TC-ADMIN-014 slug rules and who may provision.
const db = testDb();

beforeAll(async () => {
  await seedOnce();
  await startClerkStub();
}, 120_000);
afterAll(async () => {
  await stopClerkStub();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  resetClerkStub();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
});

/** A real PlatformContext for the seeded SUPER_ADMIN, for services read directly rather than through an action. */
async function platformCtx(): Promise<PlatformContext> {
  await asPlatformAdmin();
  return requirePlatform("platform:tenant:read");
}

/** Creates a tenant through the real action and returns its ids. */
async function provision(slug: string, overrides: Record<string, unknown> = {}) {
  await asPlatformAdmin();
  return dataOf(await invokeAction(createTenantAction, newTenantInput({ slug, adminEmail: `${slug}.owner@example.test`, ...overrides })));
}

describe("TC-ADMIN-013 a new tenant is a restaurant with a themed, complete website", () => {
  it("seeds the default section layout and the PLATFORM theme in the tenant's own transaction", async () => {
    const created = await provision("seaview-shack", { tenantName: "Seaview Shack", restaurantName: "Seaview Shack" });
    const restaurant = await db.restaurant.findUniqueOrThrow({ where: { tenantId: created.tenantId } });

    expect(restaurant).toMatchObject({
      themePreset: "PLATFORM",
      themeSurfaceMode: "DARK",
      themePrimaryHex: null,
      themeSecondaryHex: null,
      brandAccentHex: null,
      websitePublished: false,
    });

    const sections = await db.websiteSection.findMany({ where: { tenantId: created.tenantId }, orderBy: { sortOrder: "asc" } });
    expect(sections.map((s) => s.key).sort()).toEqual([...WEBSITE_SECTION_KEYS].sort());
    for (const section of sections) {
      expect(section, section.key).toMatchObject({
        restaurantId: restaurant.id,
        enabled: WEBSITE_SECTION_DEFAULTS[section.key].enabled,
        sortOrder: WEBSITE_SECTION_DEFAULTS[section.key].sortOrder,
        // No invented copy: the renderer supplies the default headings (S1-P09-T012 acceptance).
        headline: null,
        body: null,
        imageUrl: null,
        ctaLabel: null,
        ctaHref: null,
      });
    }
    expect(sections.find((s) => s.key === "HERO")!.enabled).toBe(true);

    // Same transaction as the tenant and restaurant rows: a half-provisioned tenant cannot exist (SC-AUD-02).
    const txId = await xminOf("tenants", created.tenantId);
    expect(await xminOf("restaurants", restaurant.id)).toBe(txId);
    const sectionXmin = await db.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM website_sections WHERE tenant_id = ${created.tenantId}::uuid`;
    expect(new Set(sectionXmin.map((r) => r.xmin))).toEqual(new Set([txId]));
  });

  it("renders a complete public site before anyone edits it", async () => {
    const created = await provision("hilltop-tiffin", { tenantName: "Hilltop Tiffin", restaurantName: "Hilltop Tiffin" });
    // Publishing itself needs a published menu (SA-RST-06); this test is about the website being complete when it is.
    await db.restaurant.update({ where: { tenantId: created.tenantId }, data: { websitePublished: true } });

    const site = await getPublicSite("hilltop-tiffin");
    expect(site.restaurant.name).toBe("Hilltop Tiffin");
    expect(site.theme).toMatchObject({ preset: "PLATFORM", surfaceMode: "DARK" });
    expect(site.cssVariables["--site-primary"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(site.cssVariables["--site-surface"]).toMatch(/^#[0-9A-F]{6}$/);

    const keys = site.sections.map((s) => s.key);
    expect(keys[0]).toBe("HERO");
    expect(keys).toEqual([...keys].sort((a, b) => WEBSITE_SECTION_DEFAULTS[a].sortOrder - WEBSITE_SECTION_DEFAULTS[b].sortOrder));
    // Only the sections that can be filled from real data; nothing is invented or empty by default.
    expect(keys).not.toContain("GALLERY");
    expect(keys).not.toContain("POPULAR_ITEMS");
    expect(site.sections.every((s) => s.headline.length > 0 && s.customHeadline === false)).toBe(true);
    expect(site.sections.every((s) => s.body === null)).toBe(true);
    expect(site.identity.tagline).toBeNull();
  });

  it("records the handover once the restaurant's administrator has accepted, and is idempotent", async () => {
    const created = await provision("river-bend-cafe", { tenantName: "River Bend Cafe", restaurantName: "River Bend Cafe" });

    // Before the invitation is accepted, there is nobody to hand over to.
    await asPlatformAdmin();
    const early = errorOf(await invokeAction(handOverTenantAction, { targetTenantId: created.tenantId }));
    expect(early.code).toBe("HANDOVER_NOT_READY");
    expect(await db.auditLog.count({ where: { tenantId: created.tenantId, action: "tenant.handed_over" } })).toBe(0);

    const { userId: superAdminId } = await asPlatformAdmin();
    expect((await inspectTenant(await platformCtx(), created.tenantId)).tenant).toMatchObject({ provisioningState: "PROVISIONING", handedOverAt: null });

    await db.userTenant.update({ where: { id: created.membershipId }, data: { status: "ACTIVE", acceptedAt: new Date() } });

    await asPlatformAdmin();
    const handover = dataOf(await invokeAction(handOverTenantAction, { targetTenantId: created.tenantId, note: "Owner trained on the console" }));
    expect(handover).toMatchObject({ tenantId: created.tenantId, provisioningState: "HANDED_OVER", alreadyHandedOver: false });
    expect(Date.parse(handover.handedOverAt)).not.toBeNaN();

    const audits = await db.auditLog.findMany({ where: { tenantId: created.tenantId, action: "tenant.handed_over" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: superAdminId, actorRole: "SUPER_ADMIN", resourceType: "tenant", resourceId: created.tenantId, reason: "Owner trained on the console" });
    expect(audits[0].afterState).toMatchObject({ provisioningState: "HANDED_OVER", slug: "river-bend-cafe" });

    // A second handover writes nothing and reports the first one.
    await asPlatformAdmin();
    const again = dataOf(await invokeAction(handOverTenantAction, { targetTenantId: created.tenantId }));
    expect(again).toMatchObject({ provisioningState: "HANDED_OVER", alreadyHandedOver: true, handedOverAt: handover.handedOverAt });
    expect(await db.auditLog.count({ where: { tenantId: created.tenantId, action: "tenant.handed_over" } })).toBe(1);

    const inspection = await inspectTenant(await platformCtx(), created.tenantId);
    expect(inspection.tenant).toMatchObject({ provisioningState: "HANDED_OVER" });
    expect(inspection.tenant.handedOverAt).toBe(handover.handedOverAt);
    expect(inspection.lifecycle.map((e) => e.action)).toContain("tenant.handed_over");
  });
});

describe("TC-ADMIN-014 slugs are reserved, unique, and immutable — and only the platform may provision", () => {
  it("refuses every reserved label, including the host labels that are not application routes", async () => {
    await asPlatformAdmin();
    const before = await platformSnapshot();
    for (const slug of ["admin", "api", "www", "app", "static", "assets", "mail", "sign-in", "account", "restaurant"]) {
      const error = errorOf(await invokeAction(createTenantAction, newTenantInput({ slug, adminEmail: `${slug}.x@example.test` })));
      expect(error, slug).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(error.fieldErrors?.slug?.[0], slug).toMatch(/reserved/i);
    }
    // The reserved list really is the host list, so a slug can never shadow an operator host.
    expect(RESERVED_HOST_LABELS).toContain("www");
    expect(RESERVED_HOST_LABELS).toContain("app");
    expect(await platformSnapshot()).toEqual(before);
  });

  it("refuses a duplicate slug and a malformed one without writing anything", async () => {
    await asPlatformAdmin();
    const before = await platformSnapshot();
    const duplicate = errorOf(await invokeAction(createTenantAction, newTenantInput({ slug: "Spice-Route", adminEmail: "dup.provision@example.test" })));
    expect(duplicate).toMatchObject({ code: "SLUG_TAKEN", fieldErrors: { slug: ["This slug is already in use"] } });

    for (const slug of ["ab", "bad_slug", "-x-y", "x".repeat(49), "UPPER-CASE-ONLY-öö"]) {
      const error = errorOf(await invokeAction(createTenantAction, newTenantInput({ slug, adminEmail: "bad.slug@example.test" })));
      expect(error.code, slug).toBe("VALIDATION_ERROR");
      expect(error.fieldErrors?.slug, slug).toBeDefined();
    }
    expect(await platformSnapshot()).toEqual(before);
  });

  it("the slug can be updated after provisioning if available", async () => {
    const created = await provision("lantern-street", { tenantName: "Lantern Street", restaurantName: "Lantern Street" });

    await asPlatformAdmin();
    const updated = dataOf(await invokeAction(updateTenantAction, { targetTenantId: created.tenantId, slug: "lantern-lane" }));
    expect(updated).toMatchObject({ slug: "lantern-lane", changed: true });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: created.tenantId } })).slug).toBe("lantern-lane");
    expect(await db.auditLog.count({ where: { tenantId: created.tenantId, action: "tenant.updated" } })).toBe(1);

    // Sending the current slug is a no-op, and the display name is still editable.
    await asPlatformAdmin();
    expect(dataOf(await invokeAction(updateTenantAction, { targetTenantId: created.tenantId, slug: "lantern-lane" }))).toMatchObject({ changed: false });
    await asPlatformAdmin();
    const renamed = dataOf(await invokeAction(updateTenantAction, { targetTenantId: created.tenantId, name: "Lantern Street Kitchen" }));
    expect(renamed).toMatchObject({ name: "Lantern Street Kitchen", slug: "lantern-lane", changed: true });
  });

  it("no tenant role can create a tenant or hand one over", async () => {
    const before = await platformSnapshot();
    for (const role of ["TENANT_ADMIN", "MANAGER", "CASHIER"] as const) {
      await asSeedUser("A", role);
      expect(errorOf(await invokeAction(createTenantAction, newTenantInput({ slug: "sneaky-cafe", adminEmail: "sneaky@example.test" }))).code, role).toBe("FORBIDDEN");
      await asSeedUser("A", role);
      expect(errorOf(await invokeAction(handOverTenantAction, { targetTenantId: tenantIdOf("A") })).code, role).toBe("FORBIDDEN");
    }
    expect(await platformSnapshot()).toEqual(before);
    expect(await db.auditLog.count({ where: { requestId: actorState.requestId } })).toBe(0);
  });
});

