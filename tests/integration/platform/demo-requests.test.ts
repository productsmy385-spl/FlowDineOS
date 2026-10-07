import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { listDemoRequestsAction, updateDemoRequestAction } from "@/app/admin/demo-requests/actions";
import { requestDemoAction } from "@/app/book-demo/actions";
import { testDb } from "../setup/db";
import { asAnonymous, asPlatformAdmin, asSeedUser, invokeAction, seedOnce } from "../helpers/actors";

/**
 * TC-DEMO-001…006 — Book a demo (RASOIOS-ADR-024; owner brief 2026-10-07 §25–28).
 * A visitor can only ever create a request; only the platform owner can read or follow one up.
 */
const db = testDb();

beforeAll(seedOnce, 120_000);

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const valid = (overrides: Record<string, unknown> = {}) => ({
  name: "Asha Rao",
  businessName: "Godavari Tiffins",
  phone: "93900 38335",
  email: `owner.${randomUUID().slice(0, 8)}@example.test`,
  city: "Rajahmundry",
  preferredDate: tomorrow(),
  preferredTime: "11:30",
  outletCount: 2,
  message: "Two outlets, one cloud kitchen.",
  ...overrides,
});

describe("TC-DEMO-001 a visitor's request is stored, validated and confirmed", () => {
  it("stores the request with the mobile number made international, and audits it without contact details", async () => {
    asAnonymous();
    const input = valid();
    expect(await invokeAction(requestDemoAction, input)).toEqual({ ok: true, data: { received: true } });
    const row = await db.demoRequest.findFirstOrThrow({ where: { email: input.email } });
    expect(row).toMatchObject({ phone: "+919390038335", city: "Rajahmundry", outletCount: 2, status: "NEW" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "demo_request.created", resourceId: row.id } });
    expect(JSON.stringify(audit.afterState)).not.toContain(input.email);
    expect(audit.tenantId).toBeNull();
  });

  it.each([
    ["an invalid email", { email: "not-an-email" }, "email"],
    ["an invalid phone", { phone: "12" }, "phone"],
    ["a past date", { preferredDate: "2020-01-01" }, "preferredDate"],
    ["a bad time", { preferredTime: "25:99" }, "preferredTime"],
    ["a missing name", { name: "" }, "name"],
    ["a tenant id", { tenantId: randomUUID() }, null],
  ])("refuses %s", async (_label, overrides, field) => {
    asAnonymous();
    const result = await invokeAction(requestDemoAction, valid(overrides) as never);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    if (field) expect((result as { error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors?.[field]).toBeDefined();
  });
});

describe("TC-DEMO-002 spam is held back before anything is written", () => {
  it("a filled trap field gets the same answer and stores nothing", async () => {
    asAnonymous();
    const input = valid({ website: "http://spam.example" });
    expect(await invokeAction(requestDemoAction, input)).toEqual({ ok: true, data: { received: true } });
    expect(await db.demoRequest.count({ where: { email: input.email } })).toBe(0);
  });

  it("the same email is limited to five requests an hour", async () => {
    asAnonymous();
    const email = `flood.${randomUUID().slice(0, 8)}@example.test`;
    for (let i = 0; i < 5; i++) expect(await invokeAction(requestDemoAction, valid({ email }))).toMatchObject({ ok: true });
    expect(await invokeAction(requestDemoAction, valid({ email }))).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await db.demoRequest.count({ where: { email } })).toBe(5);
  });
});

describe("TC-DEMO-003 only the platform owner reads and follows up requests", () => {
  it("the Super Admin lists requests and records a follow-up, audited", async () => {
    asAnonymous();
    const input = valid();
    await invokeAction(requestDemoAction, input);
    const row = await db.demoRequest.findFirstOrThrow({ where: { email: input.email } });

    await asPlatformAdmin();
    const list = await invokeAction(listDemoRequestsAction, { status: "NEW" });
    expect(list).toMatchObject({ ok: true });
    expect((list as { data: { items: { id: string }[] } }).data.items.map((r) => r.id)).toContain(row.id);

    const updated = await invokeAction(updateDemoRequestAction, { id: row.id, status: "SCHEDULED", notes: "Demo on Friday 11:30" });
    expect(updated).toMatchObject({ ok: true, data: { status: "SCHEDULED", notes: "Demo on Friday 11:30" } });
    expect(await db.auditLog.count({ where: { action: "demo_request.updated", resourceId: row.id } })).toBe(1);
  });

  it.each(["TENANT_ADMIN", "MANAGER", "CASHIER"] as const)("a restaurant's %s cannot see platform demo requests", async (role) => {
    await asSeedUser("A", role);
    const result = await invokeAction(listDemoRequestsAction, {});
    expect(result).toMatchObject({ ok: false });
    expect(["FORBIDDEN", "NO_ACTIVE_MEMBERSHIP"]).toContain((result as { error: { code: string } }).error.code);
  });

  it("a visitor cannot read requests at all", async () => {
    asAnonymous();
    expect(await invokeAction(listDemoRequestsAction, {})).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });
});
