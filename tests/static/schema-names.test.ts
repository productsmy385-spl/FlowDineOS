import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

// TC-DB-003 — the schema never models a commercial plan, tier, subscription, billing or feature flag (ADR-002, INV-10),
// and it matches the data-model conventions (S1-P02-T002). Uses the generated DMMF, so `prisma generate` succeeding
// (CI runs it before every job) doubles as `prisma validate`.
const root = path.resolve(__dirname, "../..");
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const FORBIDDEN = /plan|tier|subscription|billing|feature_?flag/i;

const { models, enums } = Prisma.dmmf.datamodel;

describe("TC-DB-003 schema names", () => {
  // 28 since migration 0002 added WEBSITE_SECTION (ADR-013 §6); 29 since 0003 added PRINTER_DISCOVERY (ADR-015).
  // 30 since 0004 added MEDIA_ASSET (ADR-017, which superseded Q-009 A); 32 since 0005 added STAFF_CREDENTIAL and
  // STAFF_SESSION (ADR-019 — staff daily-password login and the attendance they double as).
  it("has the 33 unconditional entities", () => {
    expect(models.map((m) => m.name).sort()).toEqual(
      [
        "AuditLog", "BusinessDayClose", "Customer", "DailyMenu", "DailyMenuItem", "DiningTable", "KitchenSection", "KotItem",
        "KotTicket", "MediaAsset", "MenuCategory", "MenuItem", "MenuItemAddon", "MenuItemVariant", "Order", "OrderItem",
        "OrderItemAddon", "PrintAgent", "PrintJob", "Printer", "PrinterDiscovery", "RateLimitBucket", "Restaurant", "RestaurantHours",
        "SocialPost", "StaffCredential", "StaffSession", "Tenant", "TenantCounter", "Transaction", "User", "UserTenant", "WebsiteSection",
      ].sort(),
    );
  });

  it.each(models.map((m) => [m.name, m] as const))("model %s has no commercial-plan names", (_name, model) => {
    expect(model.name).not.toMatch(FORBIDDEN);
    expect(model.dbName ?? "").not.toMatch(FORBIDDEN);
    for (const field of model.fields) {
      expect(field.name).not.toMatch(FORBIDDEN);
      expect(field.dbName ?? "").not.toMatch(FORBIDDEN);
    }
  });

  it.each(enums.map((e) => [e.name, e] as const))("enum %s has no commercial-plan names", (_name, enumType) => {
    expect(enumType.name).not.toMatch(FORBIDDEN);
    for (const value of enumType.values) expect(value.name).not.toMatch(FORBIDDEN);
  });

  it("stores money and rates as NUMERIC(12,2) / NUMERIC(5,2), never Float", () => {
    for (const model of models) {
      for (const field of model.fields) {
        expect(field.type, `${model.name}.${field.name}`).not.toBe("Float");
      }
    }
    expect(schema).not.toMatch(/\bFloat\b/);
    expect(schema).not.toMatch(/@db\.Decimal\((?!12, 2\)|5, 2\))/);
  });

  it("gives every tenant-owned model a UNIQUE (tenant_id, id) key (ADR-008)", () => {
    const tenantOwned = models.filter(
      (m) => m.fields.some((f) => f.name === "tenantId" && f.isRequired) && m.primaryKey === null,
    );
    expect(tenantOwned.length).toBeGreaterThan(20);
    for (const model of tenantOwned) {
      const hasKey = model.uniqueFields.some((u) => u.length === 2 && u[0] === "tenantId" && u[1] === "id");
      expect(hasKey, `${model.name} lacks @@unique([tenantId, id])`).toBe(true);
    }
  });

  it("uses timestamptz for every DateTime column that is not a DATE or TIME", () => {
    const dateTimeLines = schema.split("\n").filter((line) => /^\s+\w+\s+DateTime\??\s/.test(line));
    for (const line of dateTimeLines) {
      expect(line, line.trim()).toMatch(/@db\.(Timestamptz\(6\)|Date|Time\(0\))/);
    }
  });
});
