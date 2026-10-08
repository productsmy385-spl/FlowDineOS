import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as checkRoute } from "@/app/api/v1/print-agent/checks/[checkId]/route";
import { POST as claimRoute } from "@/app/api/v1/print-agent/jobs/claim/route";
import {
  archivePrinterAction,
  cancelPrintJobAction,
  closeStalePairingsAction,
  getPrinterCheckAction,
  restorePrinterAction,
  startPrinterCheckAction,
} from "@/app/restaurant/printing/actions";
import type { AgentContext } from "@/lib/auth/context-types";
import { claimJobs } from "@/lib/data/printing";
import type { PrinterCheckView } from "@/lib/services/printing";
import { asSeedUser, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { activeAgent, callAgent, dataOf, errorOf, testJob, testPrinter, type TestAgent } from "./helpers";

/**
 * Printing hardening (knowledge/implementation/printing-audit-2026-10-08.md): Test connection, cancel, archive, stale
 * pairings and one lane per printer — each through the real actions, agent routes and database.
 */
const db = testDb();
const A = tenantIdOf("A");

let agent: TestAgent;
let bAgent: TestAgent;

async function agentContext(a: TestAgent): Promise<AgentContext> {
  const printers = await db.printer.findMany({ where: { tenantId: a.tenantId, printAgentId: a.agentId, isActive: true }, select: { id: true } });
  return { kind: "agent", requestId: `test-${randomUUID().slice(0, 8)}`, agentId: a.agentId, tenantId: a.tenantId, printerIds: printers.map((p) => p.id) };
}

beforeAll(async () => {
  await seedOnce();
  agent = await activeAgent("A", { name: "Hardening agent" });
  bAgent = await activeAgent("B", { name: "Other tenant agent" });
}, 120_000);

describe("TC-PRINT-030 Test connection: the agent tests locally; nothing is printed", () => {
  it("request → the agent picks it up with its claim → reports → the console shows the result; no print job exists", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Kitchen ${randomUUID().slice(0, 4)}`, connectionAddress: "192.168.1.103:9100" });
    const jobsBefore = await db.printJob.count({ where: { tenantId: A, printerId: printer.id } });
    await asSeedUser("A", "TENANT_ADMIN");
    const started = dataOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })) as PrinterCheckView;
    expect(started).toMatchObject({ state: "WAITING", ok: null, address: "192.168.1.103:9100", agentOnline: true });
    expect(started.checkId).not.toBeNull();
    // A second click while it is open reuses the same check.
    expect((dataOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })) as PrinterCheckView).checkId).toBe(started.checkId);

    const claim = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    expect(claim.status).toBe(200);
    const checks = (claim.body as { checks: Array<{ checkId: string; printerId: string }> }).checks;
    expect(checks).toEqual([{ checkId: started.checkId, printerId: printer.id }]);

    const report = await callAgent(checkRoute, {
      url: `/api/v1/print-agent/checks/${started.checkId}`,
      params: { checkId: started.checkId! },
      body: { ok: false, errorCode: "CONNECTION_TIMEOUT", detail: "TCP 192.168.1.103:9100: no answer within 5 s", elapsedMs: 5003 },
      token: agent.token,
    });
    expect(report.status).toBe(200);

    await asSeedUser("A", "TENANT_ADMIN");
    const done = dataOf(await invokeAction(getPrinterCheckAction, { checkId: started.checkId! })) as PrinterCheckView;
    expect(done).toMatchObject({ state: "DONE", ok: false, error: { code: "CONNECTION_TIMEOUT", detail: "TCP 192.168.1.103:9100: no answer within 5 s" } });
    expect(done.error?.user).toContain("is unreachable");
    expect(done.error?.user).not.toMatch(/paper/i); // an unreachable printer is never explained as a paper problem
    expect((await db.printer.findUniqueOrThrow({ where: { id: printer.id } })).health).toBe("OFFLINE");
    expect(await db.printJob.count({ where: { tenantId: A, printerId: printer.id } })).toBe(jobsBefore);
    expect(await db.auditLog.count({ where: { tenantId: A, action: "printer.connection_test_requested", resourceId: printer.id } })).toBe(1);
  });

  it("a reachable printer reports success and turns Online", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Bar ${randomUUID().slice(0, 4)}` });
    await asSeedUser("A", "TENANT_ADMIN");
    const started = dataOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })) as PrinterCheckView;
    await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    await callAgent(checkRoute, { url: `/api/v1/print-agent/checks/${started.checkId}`, params: { checkId: started.checkId! }, body: { ok: true, elapsedMs: 12 }, token: agent.token });
    await asSeedUser("A", "TENANT_ADMIN");
    expect(dataOf(await invokeAction(getPrinterCheckAction, { checkId: started.checkId! }))).toMatchObject({ state: "DONE", ok: true, error: null, elapsedMs: 12 });
    expect((await db.printer.findUniqueOrThrow({ where: { id: printer.id } })).health).toBe("ONLINE");
  });

  it("is refused up front, with the reason, when the agent is offline or the printer has none — nothing stored", async () => {
    const offline = await activeAgent("A", { name: "Offline agent", lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    const a = await testPrinter("A", { agentId: offline.agentId, name: `Offline ${randomUUID().slice(0, 4)}` });
    const b = await testPrinter("A", { agentId: null, name: `Unassigned ${randomUUID().slice(0, 4)}` });
    await asSeedUser("A", "TENANT_ADMIN");
    expect(dataOf(await invokeAction(startPrinterCheckAction, { printerId: a.id }))).toMatchObject({ checkId: null, state: "DONE", ok: false, error: { code: "AGENT_OFFLINE" } });
    expect(dataOf(await invokeAction(startPrinterCheckAction, { printerId: b.id }))).toMatchObject({ checkId: null, ok: false, error: { code: "PRINTER_NOT_ASSIGNED" } });
    expect(await db.printerCheck.count({ where: { printerId: { in: [a.id, b.id] } } })).toBe(0);
  });

  it("an agent that never answers is reported as not responding, not as a printer fault", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Silent ${randomUUID().slice(0, 4)}` });
    await asSeedUser("A", "TENANT_ADMIN");
    const started = dataOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })) as PrinterCheckView;
    await db.printerCheck.update({ where: { id: started.checkId! }, data: { requestedAt: new Date(Date.now() - 120_000) } });
    expect(dataOf(await invokeAction(getPrinterCheckAction, { checkId: started.checkId! }))).toMatchObject({ state: "DONE", ok: false, error: { code: "AGENT_NOT_RESPONDING" } });
    expect((await db.printerCheck.findUniqueOrThrow({ where: { id: started.checkId! } })).status).toBe("EXPIRED");
  });

  it("isolation: another tenant cannot read the check, another agent cannot report it, and staff roles cannot start one", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Iso ${randomUUID().slice(0, 4)}` });
    await asSeedUser("A", "TENANT_ADMIN");
    const started = dataOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })) as PrinterCheckView;
    await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });

    await asSeedUser("B", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(getPrinterCheckAction, { checkId: started.checkId! })).code).toBe("NOT_FOUND");
    expect(errorOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })).code).toBe("NOT_FOUND");

    const foreign = await callAgent(checkRoute, { url: `/api/v1/print-agent/checks/${started.checkId}`, params: { checkId: started.checkId! }, body: { ok: true, elapsedMs: 1 }, token: bAgent.token });
    expect(foreign.status).toBe(409);
    expect((await db.printerCheck.findUniqueOrThrow({ where: { id: started.checkId! } })).status).toBe("RUNNING");

    for (const role of ["KITCHEN", "CASHIER", "WAITER"] as const) {
      await asSeedUser("A", role);
      expect(errorOf(await invokeAction(startPrinterCheckAction, { printerId: printer.id })).code, role).toBe("FORBIDDEN");
    }
  });
});

describe("TC-PRINT-031 cancel: only what is not being sent", () => {
  it("cancels a queued job (audited, never claimed afterwards); refuses one in flight or delivered", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Cancel ${randomUUID().slice(0, 4)}` });
    const queued = await testJob("A", printer.id);
    const inFlight = await testJob("A", printer.id, { status: "PROCESSING", printAgentId: agent.agentId, claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000), attemptCount: 1 });
    const delivered = await testJob("A", printer.id, { status: "PRINTED" });

    await asSeedUser("A", "MANAGER");
    const cancelled = dataOf(await invokeAction(cancelPrintJobAction, { jobId: queued.id, reason: "Order changed" })) as { status: string; displayStatus: string; cancelReason: string };
    expect(cancelled).toMatchObject({ status: "CANCELLED", displayStatus: "CANCELLED", cancelReason: "Order changed" });
    expect(await db.auditLog.count({ where: { tenantId: A, action: "print_job.cancelled", resourceId: queued.id } })).toBe(1);

    for (const job of [inFlight, delivered]) {
      expect(errorOf(await invokeAction(cancelPrintJobAction, { jobId: job.id })).code).toBe("NOT_CANCELLABLE");
    }
    expect((await db.printJob.findUniqueOrThrow({ where: { id: inFlight.id } })).status).toBe("PROCESSING");

    await db.printJob.update({ where: { id: inFlight.id }, data: { status: "PRINTED", printedAt: new Date(), leaseExpiresAt: null } });
    const claimed = await claimJobs(await agentContext(agent), 10, new Date());
    expect(claimed.map((job) => job.jobId)).not.toContain(queued.id);
  });

  it("kitchen staff can retry but not cancel; another tenant's job is a 404", async () => {
    const printer = await testPrinter("A", { agentId: agent.agentId, name: `Cancel2 ${randomUUID().slice(0, 4)}` });
    const job = await testJob("A", printer.id);
    await asSeedUser("A", "KITCHEN");
    expect(errorOf(await invokeAction(cancelPrintJobAction, { jobId: job.id })).code).toBe("FORBIDDEN");
    await asSeedUser("B", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(cancelPrintJobAction, { jobId: job.id })).code).toBe("NOT_FOUND");
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PENDING");
  });
});

describe("TC-PRINT-032 one lane per printer: a dead printer never blocks another", () => {
  it("while the kitchen printer has a job in flight, the bar printer's job is still claimed", async () => {
    const lanesAgent = await activeAgent("A", { name: "Lanes agent" });
    const kitchen = await testPrinter("A", { agentId: lanesAgent.agentId, name: `Kitchen lane ${randomUUID().slice(0, 4)}` });
    const bar = await testPrinter("A", { agentId: lanesAgent.agentId, name: `Bar lane ${randomUUID().slice(0, 4)}` });
    await testJob("A", kitchen.id, { status: "PROCESSING", printAgentId: lanesAgent.agentId, claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000), attemptCount: 1 });
    const kitchenNext = await testJob("A", kitchen.id);
    const barJob = await testJob("A", bar.id);
    const claimed = await claimJobs(await agentContext(lanesAgent), 10, new Date());
    expect(claimed.map((job) => job.jobId)).toEqual([barJob.id]);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: kitchenNext.id } })).status).toBe("PENDING");
  });
});

describe("TC-PRINT-033 archive printers and close stale pairings — nothing deleted, everything audited", () => {
  it("only a deactivated printer can be archived; it can be restored", async () => {
    const active = await testPrinter("A", { agentId: agent.agentId, name: `Live ${randomUUID().slice(0, 4)}` });
    const retired = await testPrinter("A", { agentId: null, name: `Old ${randomUUID().slice(0, 4)}`, isActive: false });
    await asSeedUser("A", "TENANT_ADMIN");
    expect(errorOf(await invokeAction(archivePrinterAction, { printerId: active.id })).code).toBe("PRINTER_ACTIVE");
    expect(dataOf(await invokeAction(archivePrinterAction, { printerId: retired.id }))).toMatchObject({ isActive: false });
    expect((await db.printer.findUniqueOrThrow({ where: { id: retired.id } })).archivedAt).not.toBeNull();
    dataOf(await invokeAction(restorePrinterAction, { printerId: retired.id }));
    expect((await db.printer.findUniqueOrThrow({ where: { id: retired.id } })).archivedAt).toBeNull();
    expect(await db.auditLog.count({ where: { tenantId: A, resourceId: retired.id, action: { in: ["printer.archived", "printer.restored"] } } })).toBe(2);
  });

  it("expired pairing attempts are closed (not deleted); a live code and paired agents are untouched", async () => {
    const createdByUserId = (await db.user.findFirstOrThrow({ where: { memberships: { some: { tenantId: A, role: "TENANT_ADMIN" } } } })).id;
    const expired = await db.printAgent.create({ data: { tenantId: A, name: "Expired code", status: "PENDING_PAIRING", pairingCodeHash: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64), pairingExpiresAt: new Date(Date.now() - 60_000), createdByUserId } });
    const live = await db.printAgent.create({ data: { tenantId: A, name: "Live code", status: "PENDING_PAIRING", pairingCodeHash: randomUUID().replace(/-/g, "").padEnd(64, "1").slice(0, 64), pairingExpiresAt: new Date(Date.now() + 5 * 60_000), createdByUserId } });
    await asSeedUser("A", "TENANT_ADMIN");
    const result = dataOf(await invokeAction(closeStalePairingsAction)) as { closed: number };
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(await db.printAgent.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ status: "REVOKED", pairingCodeHash: null });
    expect((await db.printAgent.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("PENDING_PAIRING");
    expect((await db.printAgent.findUniqueOrThrow({ where: { id: agent.agentId } })).status).toBe("ACTIVE");
    expect(await db.auditLog.count({ where: { tenantId: A, action: "print_agent.pairings_expired" } })).toBeGreaterThanOrEqual(1);
    await asSeedUser("A", "MANAGER");
    expect(errorOf(await invokeAction(closeStalePairingsAction)).code).toBe("FORBIDDEN");
  });
});
