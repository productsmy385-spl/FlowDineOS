import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTenantAction, updateTenantFeaturesAction } from "@/app/admin/actions";
import TableMenuPage from "@/app/r/[slug]/t/[code]/page";
import PublicRestaurantPage from "@/app/r/[slug]/page";
import { addTablesAction, listTablesAction } from "@/app/restaurant/tables/actions";
import TablesPage from "@/app/restaurant/tables/page";
import { getTenantResolution } from "@/lib/auth/context";
import { createMembership, createTenant, createUser } from "../../factories";
import { testDb } from "../setup/db";
import { asAnonymous, asPlatformAdmin, asSeedUser, asUserId, invokeAction, invokeLoader, seedOnce, tenantIdOf } from "../helpers/actors";
import { APP_URL, newTenantInput, resetClerkStub, startClerkStub, stopClerkStub } from "./helpers";

/**
 * TC-FEAT-001…006 — per-restaurant feature switches (RASOIOS-ADR-023; owner decision 2026-10-06).
 * A switched-off feature is refused by the server everywhere — actions, pages, public pages — not merely hidden.
 */
const db = testDb();

beforeAll(async () => {
  await seedOnce();
  // Creating a restaurant sends its administrator an invitation: Clerk is stubbed and the app address set, as in
  // create-tenant.test.ts.
  await startClerkStub();
}, 120_000);
afterAll(stopClerkStub);
beforeEach(() => {
  resetClerkStub();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
});
afterEach(() => vi.unstubAllEnvs());

/** A published restaurant of its own with its administrator. */
async function restaurant() {
  const { tenant } = await createTenant(db);
  await db.restaurant.updateMany({ where: { tenantId: tenant.id }, data: { websitePublished: true } });
  const owner = await createUser(db);
  await createMembership(db, tenant.id, owner.id, "TENANT_ADMIN");
  return { tenant, owner };
}

const setFeatures = async (tenantId: string, enabled: string[]) => {
  await asPlatformAdmin();
  return invokeAction(updateTenantFeaturesAction, { targetTenantId: tenantId, enabled: enabled as never });
};
const ALL = ["ORDERS", "KITCHEN", "PRINTING", "BILLING", "MENU", "DAILY_MENU", "CUSTOMERS", "REPORTS", "QR_MENU", "WEBSITE", "STAFF", "SOCIAL", "DATA"];

describe("TC-FEAT-001 a switched-off feature is refused by the server", () => {
  it("actions answer FEATURE_DISABLED, pages go to the not-enabled page, and the permission is gone from the session", async () => {
    const { tenant, owner } = await restaurant();
    expect(await setFeatures(tenant.id, ALL.filter((f) => f !== "QR_MENU"))).toMatchObject({ ok: true });

    await asUserId(owner.id);
    expect(await invokeAction(listTablesAction)).toMatchObject({ ok: false, error: { code: "FEATURE_DISABLED" } });
    expect(await invokeAction(addTablesAction, { count: 1 })).toMatchObject({ ok: false, error: { code: "FEATURE_DISABLED" } });
    expect(await invokeLoader(TablesPage)).toEqual({ redirect: "/account/feature-disabled?feature=QR_MENU" });
    const resolution = await getTenantResolution();
    expect(resolution.outcome === "OK" && resolution.ctx.permissions.has("table:manage")).toBe(false);
    // Everything else the administrator had is still there.
    expect(resolution.outcome === "OK" && resolution.ctx.permissions.has("order:create")).toBe(true);
  });

  it("turning it back on restores it on the next request", async () => {
    const { tenant, owner } = await restaurant();
    await setFeatures(tenant.id, ALL.filter((f) => f !== "QR_MENU"));
    await setFeatures(tenant.id, ALL);
    await asUserId(owner.id);
    expect(await invokeAction(addTablesAction, { count: 1 })).toMatchObject({ ok: true });
  });
});

describe("TC-FEAT-002 public pages follow the switches", () => {
  it("with Public website off the site is the same 404 as an unknown one; with Table QR off a table's QR stops working", async () => {
    const { tenant, owner } = await restaurant();
    await asUserId(owner.id);
    await invokeAction(addTablesAction, { label: "T1" });
    const table = await db.diningTable.findFirstOrThrow({ where: { tenantId: tenant.id } });

    asAnonymous();
    expect(await invokeLoader(PublicRestaurantPage, { params: Promise.resolve({ slug: tenant.slug }) })).not.toEqual({ notFound: true });
    expect(await invokeLoader(TableMenuPage, { params: Promise.resolve({ slug: tenant.slug, code: table.publicCode }) })).not.toEqual({ notFound: true });

    await setFeatures(tenant.id, ALL.filter((f) => f !== "QR_MENU"));
    asAnonymous();
    expect(await invokeLoader(TableMenuPage, { params: Promise.resolve({ slug: tenant.slug, code: table.publicCode }) })).toEqual({ notFound: true });
    expect(await invokeLoader(PublicRestaurantPage, { params: Promise.resolve({ slug: tenant.slug }) })).not.toEqual({ notFound: true });

    await setFeatures(tenant.id, ALL.filter((f) => f !== "WEBSITE"));
    asAnonymous();
    expect(await invokeLoader(PublicRestaurantPage, { params: Promise.resolve({ slug: tenant.slug }) })).toEqual({ notFound: true });
  });
});

describe("TC-FEAT-003 changes are audited with exactly what changed", () => {
  it("records before and after for the changed features only", async () => {
    const { tenant } = await restaurant();
    await setFeatures(tenant.id, ALL.filter((f) => f !== "SOCIAL" && f !== "DATA"));
    const row = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: "tenant.features_updated" }, orderBy: { createdAt: "desc" } });
    expect(row.beforeState).toEqual({ SOCIAL: "enabled", DATA: "enabled" });
    expect(row.afterState).toEqual({ SOCIAL: "disabled", DATA: "disabled" });
    expect(row.actorRole).toBe("SUPER_ADMIN");
  });
});

describe("TC-FEAT-004 a new restaurant starts with the features chosen for it", () => {
  it("stores the unticked features as off", async () => {
    await asPlatformAdmin();
    const slug = `feat-${randomUUID().slice(0, 8)}`;
    const created = await invokeAction(createTenantAction, newTenantInput({ slug, adminEmail: `owner.${slug}+clerk_test@example.com`, enabledFeatures: ["ORDERS", "KITCHEN", "MENU"] }));
    expect(created).toMatchObject({ ok: true });
    const tenantId = (created as { data: { tenantId: string } }).data.tenantId;
    const off = (await db.tenantFeature.findMany({ where: { tenantId, enabled: false }, select: { featureKey: true } })).map((f) => f.featureKey).sort();
    expect(off).toEqual(ALL.filter((f) => !["ORDERS", "KITCHEN", "MENU"].includes(f)).sort());
  });
});

describe("TC-FEAT-005 only the platform owner switches features", () => {
  it.each(["TENANT_ADMIN", "MANAGER"] as const)("%s of a restaurant cannot change its own features", async (role) => {
    await asSeedUser("A", role);
    const result = await invokeAction(updateTenantFeaturesAction, { targetTenantId: tenantIdOf("A"), enabled: ALL as never });
    expect(result).toMatchObject({ ok: false });
    expect(["FORBIDDEN", "NO_ACTIVE_MEMBERSHIP"]).toContain((result as { error: { code: string } }).error.code);
  });

  it("an unknown feature key is rejected", async () => {
    const { tenant } = await restaurant();
    expect(await setFeatures(tenant.id, ["ORDERS", "TELEPORT"])).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});
