import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as pairRoute } from "@/app/api/v1/print-agent/pair/route";
import {
  createPrintAgentPairingAction,
  createPrinterAction,
  deactivatePrinterAction,
  getAllPrintersAction,
  getPrintAgentsAction,
  revokePrintAgentAction,
  updatePrinterAction,
} from "@/app/restaurant/printing/actions";
import { PAIRING_TTL_MS } from "@/lib/services/printing";
import { asSeedUser, invokeAction, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { callAgent, dataOf, errorOf, sha256Hex, testJob, testPrinter, TRUSTED_HOPS_FOR_TESTS } from "./helpers";

/**
 * TC-PRINT-011 (printer management) and TC-AGENT-002 (pairing lifecycle) — S1-P16-T004, api.md SA-PRN-01…03,
 * SA-AGT-01/02, ADR-007 §1.
 */
const db = testDb();
const A = tenantIdOf("A");

beforeAll(seedOnce, 120_000);

// One proxy in front of the app, as in staging and production: without it a forwarded address proves nothing and
// every caller shares the pairing bucket (lib/http/client-ip.ts).
beforeEach(() => vi.stubEnv("TRUSTED_PROXY_HOPS", TRUSTED_HOPS_FOR_TESTS));
afterEach(() => vi.unstubAllEnvs());

const validPrinter = (overrides: Record<string, unknown> = {}) => ({
  name: "New Kitchen Printer",
  purpose: "KOT" as const,
  connectionType: "LAN" as const,
  connectionAddress: "192.168.1.77:9100",
  paperWidthMm: 80 as const,
  ...overrides,
});

describe("TC-PRINT-011 printer management (SA-PRN-01…03)", () => {
  it("creates a printer in the caller's tenant and audits printer.created", async () => {
    const { userId } = await asSeedUser("A", "MANAGER");
    const printer = dataOf(await invokeAction(createPrinterAction, validPrinter({ name: "Counter 2" })));
    expect(printer).toMatchObject({ name: "Counter 2", purpose: "KOT", connectionType: "LAN", paperWidthMm: 80, isActive: true, health: "UNKNOWN" });

    const row = await db.printer.findUniqueOrThrow({ where: { id: printer.id } });
    expect(row.tenantId).toBe(A);
    const audits = await db.auditLog.findMany({ where: { action: "printer.created", resourceId: printer.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorUserId: userId, actorRole: "MANAGER" });
  });

  it("refuses a public LAN address, a host name and a bad USB name (SC-PRINT-06)", async () => {
    await asSeedUser("A", "MANAGER");
    for (const address of ["8.8.8.8:9100", "localhost:9100", "printer.example.com", "192.168.1.50:99999"]) {
      const result = await invokeAction(createPrinterAction, validPrinter({ connectionAddress: address }));
      expect(result, address).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(await invokeAction(createPrinterAction, validPrinter({ connectionType: "USB", connectionAddress: "USB001; rm -rf /" }))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(await invokeAction(createPrinterAction, validPrinter({ connectionType: "USB", connectionAddress: "USB001" }))).toMatchObject({ ok: true });
  });

  it("TI-044 refuses a Tenant B kitchen section or agent with the same 404 as an unknown id", async () => {
    const bSection = await db.kitchenSection.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    const bAgent = await db.printAgent.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } });
    await asSeedUser("A", "MANAGER");
    const before = await db.printer.count();

    const foreignSection = errorOf(await invokeAction(createPrinterAction, validPrinter({ kitchenSectionId: bSection.id })));
    const foreignAgent = errorOf(await invokeAction(createPrinterAction, validPrinter({ printAgentId: bAgent.id })));
    const unknown = errorOf(await invokeAction(createPrinterAction, validPrinter({ kitchenSectionId: "5b0c3f1e-9a8d-4c2b-8f7e-6d5c4b3a2f10" })));

    expect(foreignSection.code).toBe("NOT_FOUND");
    expect(foreignSection).toEqual(unknown);
    expect(foreignAgent.code).toBe("NOT_FOUND");
    expect(await db.printer.count()).toBe(before);
  });

  it("updates a printer, re-validating the address against the effective connection type", async () => {
    const printer = await testPrinter("A", { name: "Editable", connectionType: "LAN", connectionAddress: "192.168.1.10:9100" });
    await asSeedUser("A", "MANAGER");

    const updated = dataOf(await invokeAction(updatePrinterAction, { printerId: printer.id, name: "Renamed", paperWidthMm: 58 }));
    expect(updated).toMatchObject({ name: "Renamed", paperWidthMm: 58, connectionAddress: "192.168.1.10:9100" });

    expect(dataOf(await invokeAction(updatePrinterAction, { printerId: printer.id, connectionType: "USB", connectionAddress: "USB007" }))).toMatchObject({
      connectionType: "USB",
      connectionAddress: "USB007",
    });
    // Switching back to LAN without a new address is refused: the stored USB name is not a private LAN address, so
    // the printer would be left in a state the server would never have accepted in one step (SC-PRINT-06).
    expect(await invokeAction(updatePrinterAction, { printerId: printer.id, connectionType: "LAN" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    // Sending a new address without saying which kind it is, is also refused.
    expect(await invokeAction(updatePrinterAction, { printerId: printer.id, connectionAddress: "192.168.1.11:9100" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });

    const audits = await db.auditLog.findMany({ where: { action: "printer.updated", resourceId: printer.id } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].beforeState).toMatchObject({ name: "Editable" });
  });

  it("deactivation fails the printer's PENDING jobs with PRINTER_DEACTIVATED and leaves settled jobs alone", async () => {
    const printer = await testPrinter("A", { name: "Doomed" });
    const pending = await testJob("A", printer.id, { status: "PENDING" });
    const processing = await testJob("A", printer.id, { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() + 60_000) });
    const printed = await db.printJob.create({
      data: { tenantId: A, printerId: printer.id, jobType: "TEST", dedupeKey: `TEST:done-${printer.id}`, payload: {}, status: "PRINTED", printedAt: new Date() },
    });

    await asSeedUser("A", "MANAGER");
    const result = dataOf(await invokeAction(deactivatePrinterAction, { printerId: printer.id }));
    expect(result).toMatchObject({ failedJobs: 1, printer: { isActive: false, health: "UNKNOWN" } });

    expect(await db.printJob.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "FAILED", lastErrorCode: "PRINTER_DISABLED" });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: processing.id } })).status).toBe("PROCESSING");
    expect((await db.printJob.findUniqueOrThrow({ where: { id: printed.id } })).status).toBe("PRINTED");

    expect(await invokeAction(deactivatePrinterAction, { printerId: printer.id })).toMatchObject({ ok: false, error: { code: "ALREADY_DEACTIVATED" } });
    expect(await db.auditLog.count({ where: { action: "printer.deactivated", resourceId: printer.id } })).toBe(1);
  });

  it("TI-046 deactivating a Tenant B printer is NOT_FOUND and changes nothing", async () => {
    const bPrinter = await db.printer.findFirstOrThrow({ where: { tenantId: tenantIdOf("B"), isActive: true } });
    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(deactivatePrinterAction, { printerId: bPrinter.id })).code).toBe("NOT_FOUND");
    expect((await db.printer.findUniqueOrThrow({ where: { id: bPrinter.id } })).isActive).toBe(true);
  });

  it("CASHIER and KITCHEN have no printer:manage", async () => {
    for (const role of ["CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(await invokeAction(createPrinterAction, validPrinter()), role).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(await invokeAction(getAllPrintersAction), role).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });
});

describe("TC-AGENT-002 pairing lifecycle (SA-AGT-01, RH-AGT-01, SC-PRINT-02)", () => {
  it("returns the code once, stores only its hash, and never writes it to an audit row", async () => {
    const { userId } = await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: "Bar PC" }));

    expect(issued.pairingCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(PAIRING_TTL_MS - 60_000);

    const row = await db.printAgent.findUniqueOrThrow({ where: { id: issued.agentId } });
    expect(row).toMatchObject({ tenantId: A, status: "PENDING_PAIRING", tokenHash: null, tokenPrefix: null });
    expect(row.pairingCodeHash).toBe(sha256Hex(issued.pairingCode));

    const audits = await db.auditLog.findMany({ where: { action: "print_agent.created", resourceId: issued.agentId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorUserId: userId });
    expect(JSON.stringify(audits[0].afterState)).not.toContain(issued.pairingCode);
  });

  it("is single-use: the second exchange of the same code is 401", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: "Single use PC" }));

    const first = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: issued.pairingCode, agentVersion: "1.0.0", osInfo: "Windows 11" },
      ip: "203.0.113.11",
    });
    expect(first.status).toBe(201);
    const paired = first.body as { agentId: string; token: string };
    expect(paired.agentId).toBe(issued.agentId);
    expect(paired.token).toMatch(/^rsa_[A-Za-z0-9_-]{20,}$/);

    const second = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: issued.pairingCode, agentVersion: "1.0.0", osInfo: "Windows 11" },
      ip: "203.0.113.12",
    });
    expect(second.status).toBe(401);
    expect(second.body).toMatchObject({ error: { code: "INVALID_PAIRING_CODE" } });

    const row = await db.printAgent.findUniqueOrThrow({ where: { id: issued.agentId } });
    expect(row).toMatchObject({ status: "ACTIVE", pairingCodeHash: null, pairingExpiresAt: null, agentVersion: "1.0.0", osInfo: "Windows 11" });
    expect(row.tokenHash).toBe(sha256Hex(paired.token));
    expect(row.tokenPrefix).toBe(paired.token.slice(0, 8));
    expect(row.lastSeenAt).not.toBeNull();
  });

  it("expires after ten minutes, and a wrong code is the same 401", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: "Expired PC" }));
    await db.printAgent.update({ where: { id: issued.agentId }, data: { pairingExpiresAt: new Date(Date.now() - 1000) } });

    const expired = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: issued.pairingCode, agentVersion: "1.0.0", osInfo: "Windows 11" },
      ip: "203.0.113.21",
    });
    const wrong = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: "ABCDEFGH", agentVersion: "1.0.0", osInfo: "Windows 11" },
      ip: "203.0.113.22",
    });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(wrong.body ? { error: { ...(wrong.body as { error: Record<string, unknown> }).error, requestId: (expired.body as { error: { requestId: string } }).error.requestId } } : wrong.body);
    expect((await db.printAgent.findUniqueOrThrow({ where: { id: issued.agentId } })).status).toBe("PENDING_PAIRING");
  });

  it("rejects a malformed code and any unknown field with 422", async () => {
    for (const body of [
      { pairingCode: "SHORT", agentVersion: "1.0.0", osInfo: "Windows 11" },
      { pairingCode: "ABCDEFGI", agentVersion: "1.0.0", osInfo: "Windows 11" }, // `I` is not in the alphabet
      { pairingCode: "ABCDEFGH", agentVersion: "1.0.0", osInfo: "Windows 11", tenantId: A },
      { pairingCode: "ABCDEFGH" },
    ]) {
      const response = await callAgent(pairRoute, { url: "/api/v1/print-agent/pair", body, ip: `203.0.113.${30 + Math.floor(Math.random() * 60)}` });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("TI-046 revoking clears the token and the next revoke is a conflict; a Tenant B agent is NOT_FOUND", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: "Revokable PC" }));
    const paired = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: issued.pairingCode, agentVersion: "1.0.0", osInfo: "Windows 11" },
      ip: "203.0.113.41",
    });
    expect(paired.status).toBe(201);

    const revoked = dataOf(await invokeAction(revokePrintAgentAction, { agentId: issued.agentId }));
    expect(revoked).toMatchObject({ status: "REVOKED" });
    const row = await db.printAgent.findUniqueOrThrow({ where: { id: issued.agentId } });
    expect(row).toMatchObject({ status: "REVOKED", tokenHash: null });
    expect(row.revokedAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { action: "print_agent.revoked", resourceId: issued.agentId } })).toBe(1);

    expect(await invokeAction(revokePrintAgentAction, { agentId: issued.agentId })).toMatchObject({ ok: false, error: { code: "ALREADY_REVOKED" } });

    const bAgent = await db.printAgent.findFirstOrThrow({ where: { tenantId: tenantIdOf("B"), status: { not: "REVOKED" } } });
    expect(errorOf(await invokeAction(revokePrintAgentAction, { agentId: bAgent.id })).code).toBe("NOT_FOUND");
    expect((await db.printAgent.findUniqueOrThrow({ where: { id: bAgent.id } })).status).not.toBe("REVOKED");
  });

  it("only TENANT_ADMIN holds print_agent:manage", async () => {
    for (const role of ["MANAGER", "CASHIER", "KITCHEN", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(await invokeAction(createPrintAgentPairingAction, { name: "Nope" }), role).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(await invokeAction(getPrintAgentsAction), role).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("limits pairing creation to 10 per hour per tenant", async () => {
    await asSeedUser("B", "TENANT_ADMIN");
    for (let i = 0; i < 10; i++) dataOf(await invokeAction(createPrintAgentPairingAction, { name: `Bulk ${i}` }));
    expect(await invokeAction(createPrintAgentPairingAction, { name: "Eleventh" })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await db.printAgent.count({ where: { tenantId: tenantIdOf("B"), name: "Eleventh" } })).toBe(0);
  });
});

describe("LD-PRN-01 console reads", () => {
  it("shows every printer of the tenant including deactivated ones, and never another tenant's", async () => {
    await asSeedUser("A", "MANAGER");
    const printers = dataOf(await invokeAction(getAllPrintersAction));
    const expected = await db.printer.findMany({ where: { tenantId: A }, select: { id: true } });
    expect(printers.map((p) => p.id).sort()).toEqual(expected.map((p) => p.id).sort());
    expect(printers.some((p) => !p.isActive), "the deactivated printer is still listed").toBe(true);

    const bIds = new Set((await db.printer.findMany({ where: { tenantId: tenantIdOf("B") }, select: { id: true } })).map((p) => p.id));
    expect(printers.some((p) => bIds.has(p.id))).toBe(false);
  });

  it("derives an agent's online flag from last_seen_at rather than storing one", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const fresh = await db.printAgent.findFirstOrThrow({ where: { tenantId: A, id: seeded("A", "agent:active") } });
    await db.printAgent.update({ where: { id: fresh.id }, data: { lastSeenAt: new Date() } });
    expect(dataOf(await invokeAction(getPrintAgentsAction)).find((a) => a.id === fresh.id)?.online).toBe(true);

    await db.printAgent.update({ where: { id: fresh.id }, data: { lastSeenAt: new Date(Date.now() - 120_000) } });
    expect(dataOf(await invokeAction(getPrintAgentsAction)).find((a) => a.id === fresh.id)?.online).toBe(false);

    const revokedAgent = dataOf(await invokeAction(getPrintAgentsAction)).find((a) => a.status === "REVOKED");
    expect(revokedAgent?.online ?? false).toBe(false);
  });
});
