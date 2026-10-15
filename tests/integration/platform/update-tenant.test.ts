import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateTenantAction } from "@/app/admin/actions";
import { createTenant } from "../../factories";
import { testDb } from "../setup/db";
import { asPlatformAdmin, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { RANDOM_UUID, dataOf, errorOf } from "../orders/helpers";
import { clerkCalls, resetClerkStub, startClerkStub, stopClerkStub, xminOf } from "./helpers";

vi.mock("@/lib/auth/clerk-admin", async (importOriginal) => {
  const { stubbedClerkAdminModule } = await import("./helpers");
  return stubbedClerkAdminModule(await importOriginal());
});

// TC-ADMIN-004 (SA-ADM-02) — renaming a tenant, audited before/after (S1-P06-T001). The slug became immutable in
// S1-P09-T011 (ADR-012 §4, 2026-09-23), so the confirmed-slug-change cases of the original task are replaced by
// SLUG_IMMUTABLE here; the rest of the slug rules now apply at creation only (tests/integration/platform/provisioning).
const db = testDb();

beforeAll(async () => {
  await seedOnce();
  await startClerkStub();
}, 120_000);
afterAll(stopClerkStub);
beforeEach(resetClerkStub);

async function freshTenant(slug: string, name = "Riverside Dhaba") {
  const { tenant } = await createTenant(db, { name, slug });
  return tenant;
}

describe("TC-ADMIN-004 update tenant name and slug", () => {
  it("renames a tenant and audits the before/after in the same transaction", async () => {
    await asPlatformAdmin();
    const tenant = await freshTenant("riverside-dhaba");
    const data = dataOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, name: "  Riverside Dhaba & Grill " }));
    expect(data).toEqual({ tenantId: tenant.id, name: "Riverside Dhaba & Grill", slug: "riverside-dhaba", changed: true });

    const row = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(row).toMatchObject({ name: "Riverside Dhaba & Grill", slug: "riverside-dhaba" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: "tenant.updated" } });
    expect(audit).toMatchObject({ actorRole: "SUPER_ADMIN", resourceType: "tenant", resourceId: tenant.id, beforeState: { name: "Riverside Dhaba" }, afterState: { name: "Riverside Dhaba & Grill" } });
    expect(await xminOf("audit_logs", audit.id)).toBe(await xminOf("tenants", tenant.id));
  });

  it("allows updating slug when available and records audit log", async () => {
    await asPlatformAdmin();
    const tenant = await freshTenant("hilltop-cafe");
    const data = dataOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, slug: "hilltop-kitchen" }));
    expect(data).toMatchObject({ slug: "hilltop-kitchen", changed: true });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).slug).toBe("hilltop-kitchen");
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: "tenant.updated" } });
    expect(audit).toMatchObject({
      actorRole: "SUPER_ADMIN",
      resourceType: "tenant",
      resourceId: tenant.id,
      beforeState: { slug: "hilltop-cafe" },
      afterState: { slug: "hilltop-kitchen", subdomain: "hilltop-kitchen" },
    });
  });

  it("refuses a taken, reserved or malformed slug", async () => {
    await asPlatformAdmin();
    const tenant = await freshTenant("lakeview-tiffins");
    // A slug that is already another tenant's is refused with SLUG_UNAVAILABLE.
    expect(errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, slug: "harbour-grill" })).code).toBe("SLUG_UNAVAILABLE");

    for (const slug of ["admin", "sign-up", "account", "api", "www"]) {
      const error = errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, slug }));
      expect(error, slug).toMatchObject({ code: "VALIDATION_ERROR", fieldErrors: { slug: [expect.stringContaining("reserved")] } });
    }
    for (const slug of ["ab", "bad_slug", "-x-y", "x".repeat(49)]) {
      const error = errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, slug }));
      expect(error.code, slug).toBe("VALIDATION_ERROR");
      expect(error.fieldErrors?.slug, slug).toBeDefined();
    }
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).slug).toBe("lakeview-tiffins");
    expect(await db.auditLog.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("an unchanged name and slug is a no-op without an audit row; an empty update is a validation error", async () => {
    await asPlatformAdmin();
    const tenant = await freshTenant("same-same-cafe", "Same Same Cafe");
    expect(dataOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, name: "Same Same Cafe", slug: "same-same-cafe" }))).toMatchObject({ changed: false });
    expect(await db.auditLog.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id })).code).toBe("VALIDATION_ERROR");
    expect(errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenant.id, name: "X" })).fieldErrors?.name).toBeDefined();
  });

  it("an unknown tenant is NOT_FOUND and a tenantId field is rejected", async () => {
    await asPlatformAdmin();
    expect(errorOf(await invokeAction(updateTenantAction, { targetTenantId: RANDOM_UUID, name: "Ghost Kitchen" })).code).toBe("NOT_FOUND");
    expect(errorOf(await invokeAction(updateTenantAction, { targetTenantId: "not-a-uuid", name: "Ghost Kitchen" })).code).toBe("VALIDATION_ERROR");
    const extra = errorOf(await invokeAction(updateTenantAction, { targetTenantId: tenantIdOf("B"), tenantId: tenantIdOf("B"), name: "Harbour" } as never));
    expect(extra.code).toBe("VALIDATION_ERROR");
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantIdOf("B") } })).name).toBe("Harbour Grill");
    expect(clerkCalls()).toEqual([]);
  });
});
