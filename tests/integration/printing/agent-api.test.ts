import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as configRoute } from "@/app/api/v1/print-agent/config/route";
import { POST as heartbeatRoute } from "@/app/api/v1/print-agent/heartbeat/route";
import { POST as ackRoute } from "@/app/api/v1/print-agent/jobs/[jobId]/ack/route";
import { POST as claimRoute } from "@/app/api/v1/print-agent/jobs/claim/route";
import { POST as pairRoute } from "@/app/api/v1/print-agent/pair/route";
import { createPrintAgentPairingAction } from "@/app/restaurant/printing/actions";
import { AGENT_OFFLINE_AFTER_MS, isAgentOnline } from "@/lib/services/printing";
import { fixedClock, overrideClock } from "@/lib/time/clock";
import { asSeedUser, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { activeAgent, callAgent, dataOf, sha256Hex, testJob, testPrinter, TRUSTED_HOPS_FOR_TESTS, type TestAgent } from "./helpers";

/**
 * TC-AGENT-001 / 003 / 004 / 005 and TC-PRINT-006 — the machine API (S1-P16-T005, ADR-007, api.md RH-AGT-01…05).
 */
const db = testDb();
const A = tenantIdOf("A");

let agent: TestAgent;
let printerId: string;
let restoreClock: (() => void) | null = null;

beforeAll(async () => {
  await seedOnce();
  agent = await activeAgent("A", { name: "API agent" });
  printerId = (await testPrinter("A", { agentId: agent.agentId, name: "API printer", paperWidthMm: 58 })).id;
}, 120_000);

// One proxy in front of the app, as in staging and production: without it a forwarded address proves nothing and
// every caller shares the pairing bucket (lib/http/client-ip.ts).
beforeEach(() => vi.stubEnv("TRUSTED_PROXY_HOPS", TRUSTED_HOPS_FOR_TESTS));
afterEach(() => vi.unstubAllEnvs());

afterEach(() => {
  restoreClock?.();
  restoreClock = null;
});

describe("TC-AGENT-001 pairing returns a token once (SC-PRINT-01)", () => {
  it("stores only the hash and prefix, and the token then authenticates other calls", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: "Fresh PC" }));

    const paired = await callAgent(pairRoute, {
      url: "/api/v1/print-agent/pair",
      body: { pairingCode: issued.pairingCode, agentVersion: "1.2.3", osInfo: "Windows 11 Pro" },
      ip: "198.51.100.10",
    });
    expect(paired.status).toBe(201);
    const body = paired.body as { agentId: string; token: string; printers: unknown[]; pollIntervalMs: number; heartbeatIntervalMs: number };
    expect(body).toMatchObject({ agentId: issued.agentId, pollIntervalMs: 3000, heartbeatIntervalMs: 30000 });
    expect(body.printers).toEqual([]);

    const row = await db.printAgent.findUniqueOrThrow({ where: { id: issued.agentId } });
    expect(row.tokenHash).toBe(sha256Hex(body.token));
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.tokenPrefix).toHaveLength(8);

    const config = await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: body.token });
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({ agentId: issued.agentId });

    const audits = await db.auditLog.findMany({ where: { action: "print_agent.paired", resourceId: issued.agentId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorType: "PRINT_AGENT", actorAgentId: issued.agentId, actorUserId: null });
    // The audit writer strips every key that looks like a credential (SC-AUD-04), so not even the prefix is kept —
    // the prefix lives on the PRINT_AGENT row, which is where the console reads it from.
    const afterState = JSON.stringify(audits[0].afterState);
    expect(afterState).not.toContain(body.token);
    expect(afterState).not.toContain(row.tokenPrefix);
    expect(afterState).toContain("ACTIVE");
  });
});

describe("TC-AGENT-003 revocation (SC-PRINT-09)", () => {
  it("makes the very next heartbeat and claim 401", async () => {
    const doomed = await activeAgent("A", { name: "Revoked soon" });
    expect((await callAgent(heartbeatRoute, { url: "/api/v1/print-agent/heartbeat", body: { printers: [] }, token: doomed.token })).status).toBe(200);

    await db.printAgent.update({ where: { id: doomed.agentId }, data: { status: "REVOKED", tokenHash: null, revokedAt: new Date() } });

    for (const call of [
      callAgent(heartbeatRoute, { url: "/api/v1/print-agent/heartbeat", body: { printers: [] }, token: doomed.token }),
      callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: doomed.token }),
      callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: doomed.token }),
    ]) {
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: "INVALID_AGENT_TOKEN" } });
    }
  });

  it("a missing, malformed, truncated or unknown token is the same 401", async () => {
    const good = agent.token;
    for (const token of [null, "", "short", good.slice(0, 12), `${good}x`, `rsa_${"a".repeat(43)}`]) {
      const response = await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token });
      expect(response.status, String(token)).toBe(401);
      expect(response.body).toMatchObject({ error: { code: "INVALID_AGENT_TOKEN" } });
    }
    // The token prefix alone is not a credential.
    const prefix = (await db.printAgent.findUniqueOrThrow({ where: { id: agent.agentId } })).tokenPrefix!;
    expect((await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: prefix })).status).toBe(401);
  });

  it("never echoes the token in the response or in a log-shaped body", async () => {
    const response = await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: agent.token });
    expect(JSON.stringify(response.body)).not.toContain(agent.token);
  });
});

describe("TC-AGENT-004 heartbeat and liveness (ADR-007 §7)", () => {
  it("records the health the agent reports and refreshes last_seen_at", async () => {
    await db.printAgent.update({ where: { id: agent.agentId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });

    const response = await callAgent(heartbeatRoute, {
      url: "/api/v1/print-agent/heartbeat",
      body: { agentVersion: "1.4.0", printers: [{ printerId, health: "ERROR", detail: "Paper out" }] },
      token: agent.token,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ pollIntervalMs: 3000, heartbeatIntervalMs: 30000 });

    const printer = await db.printer.findUniqueOrThrow({ where: { id: printerId } });
    expect(printer.health).toBe("ERROR");
    expect(printer.healthReportedAt).not.toBeNull();

    const row = await db.printAgent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(Date.now() - row.lastSeenAt!.getTime()).toBeLessThan(60_000);

    // A later report replaces the earlier one — health is a report, never an accumulation.
    await callAgent(heartbeatRoute, { url: "/api/v1/print-agent/heartbeat", body: { printers: [{ printerId, health: "ONLINE" }] }, token: agent.token });
    expect((await db.printer.findUniqueOrThrow({ where: { id: printerId } })).health).toBe("ONLINE");
  });

  it("shows the agent offline once 90 s have passed without a call (injected clock)", async () => {
    const seenAt = new Date("2026-09-15T08:30:00.000Z");
    await db.printAgent.update({ where: { id: agent.agentId }, data: { lastSeenAt: seenAt } });
    const view = { status: "ACTIVE" as const, lastSeenAt: seenAt.toISOString() };

    const clock = fixedClock("2026-09-15T08:30:30.000Z");
    restoreClock = overrideClock(clock);
    expect(isAgentOnline(view)).toBe(true);
    clock.advance(AGENT_OFFLINE_AFTER_MS);
    expect(isAgentOnline(view)).toBe(false);

    // Calling in again makes it online, because the flag is derived from the call, not stored.
    await callAgent(heartbeatRoute, { url: "/api/v1/print-agent/heartbeat", body: { printers: [] }, token: agent.token });
    const refreshed = await db.printAgent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(isAgentOnline({ status: "ACTIVE", lastSeenAt: refreshed.lastSeenAt!.toISOString() })).toBe(true);
  });

  it("rejects an unknown health value and an unknown field with 422", async () => {
    for (const body of [
      { printers: [{ printerId, health: "GREAT" }] },
      { printers: [{ printerId, health: "ONLINE", tenantId: A }] },
      { printers: [{ printerId, health: "ONLINE" }], tenantId: A },
    ]) {
      const response = await callAgent(heartbeatRoute, { url: "/api/v1/print-agent/heartbeat", body, token: agent.token });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("TC-AGENT-005 configuration (RH-AGT-05)", () => {
  it("returns only the printers assigned to the calling agent", async () => {
    const otherAgent = await activeAgent("A", { name: "Other agent" });
    const othersPrinter = await testPrinter("A", { agentId: otherAgent.agentId, name: "Someone else's printer" });
    const unassigned = await testPrinter("A", { name: "Unassigned printer" });

    const response = await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: agent.token });
    expect(response.status).toBe(200);
    const body = response.body as { agentId: string; printers: Array<{ printerId: string; name: string; paperWidthMm: number }> };
    expect(body.agentId).toBe(agent.agentId);
    expect(body.printers.map((p) => p.printerId)).toEqual([printerId]);
    expect(body.printers[0]).toMatchObject({ name: "API printer", paperWidthMm: 58, connectionType: "LAN" });
    expect(body.printers.some((p) => p.printerId === othersPrinter.id || p.printerId === unassigned.id)).toBe(false);
  });

  it("returns an empty list — never an error — for an agent with no printers", async () => {
    const orphan = await activeAgent("A", { name: "Orphan agent" });
    const response = await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: orphan.token });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ printers: [] });
  });

  it("drops a deactivated printer from the agent's configuration", async () => {
    const temporary = await testPrinter("A", { agentId: agent.agentId, name: "Temporary printer" });
    const before = (await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: agent.token })).body as { printers: Array<{ printerId: string }> };
    expect(before.printers.map((p) => p.printerId)).toContain(temporary.id);

    await db.printer.update({ where: { id: temporary.id }, data: { isActive: false } });
    const after = (await callAgent(configRoute, { url: "/api/v1/print-agent/config", method: "GET", token: agent.token })).body as { printers: Array<{ printerId: string }> };
    expect(after.printers.map((p) => p.printerId)).not.toContain(temporary.id);
  });
});

describe("TC-PRINT-006 a job stays PROCESSING until the agent acknowledges", () => {
  it("claiming alone never marks a job printed", async () => {
    await db.printJob.deleteMany({ where: { tenantId: A, printerId } });
    const job = await testJob("A", printerId, { dedupeKey: `TEST:proc-${randomUUID()}` });

    const claim = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    const claimed = (claim.body as { jobs: Array<{ jobId: string; claimToken: string }> }).jobs[0];
    expect(claimed.jobId).toBe(job.id);

    const midFlight = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(midFlight.status).toBe("PROCESSING");
    expect(midFlight.printedAt).toBeNull();

    // Repeated polls do not settle it either.
    await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 5 }, token: agent.token });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PROCESSING");

    const ack = await callAgent(ackRoute, {
      url: `/api/v1/print-agent/jobs/${job.id}/ack`,
      params: { jobId: job.id },
      body: { claimToken: claimed.claimToken, result: "PRINTED" },
      token: agent.token,
    });
    expect(ack.status).toBe(200);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PRINTED");
  });

  it("audits print_job.failed as the agent when the last attempt fails", async () => {
    await db.printJob.deleteMany({ where: { tenantId: A, printerId } });
    const job = await testJob("A", printerId, { dedupeKey: `TEST:fail-${randomUUID()}`, maxAttempts: 1 });

    const claim = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    const claimed = (claim.body as { jobs: Array<{ jobId: string; claimToken: string }> }).jobs[0];

    const ack = await callAgent(ackRoute, {
      url: `/api/v1/print-agent/jobs/${job.id}/ack`,
      params: { jobId: job.id },
      body: { claimToken: claimed.claimToken, result: "FAILED", errorCode: "PRINTER_OFFLINE", errorMessage: "connect ECONNREFUSED" },
      token: agent.token,
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: "FAILED" });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    // Out of attempts: recorded as PRINT_JOB_EXPIRED, with the cause (an older agent's code, normalised) in the message.
    expect(row).toMatchObject({ status: "FAILED", lastErrorCode: "PRINT_JOB_EXPIRED", lastErrorMessage: "PRINTER_UNREACHABLE: connect ECONNREFUSED" });

    const audits = await db.auditLog.findMany({ where: { action: "print_job.failed", resourceId: job.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorType: "PRINT_AGENT", actorAgentId: agent.agentId, actorUserId: null });
  });

  it("rejects a lower-case error code and an over-long message", async () => {
    await db.printJob.deleteMany({ where: { tenantId: A, printerId } });
    const job = await testJob("A", printerId, { dedupeKey: `TEST:valid-${randomUUID()}` });
    const claim = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    const claimed = (claim.body as { jobs: Array<{ jobId: string; claimToken: string }> }).jobs[0];

    for (const body of [
      { claimToken: claimed.claimToken, result: "PRINTED", errorCode: "offline" },
      { claimToken: claimed.claimToken, result: "FAILED", errorMessage: "x".repeat(501) },
      { claimToken: claimed.claimToken, result: "MAYBE" },
      { result: "PRINTED" },
    ]) {
      const response = await callAgent(ackRoute, { url: `/api/v1/print-agent/jobs/${job.id}/ack`, params: { jobId: job.id }, body, token: agent.token });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PROCESSING");
  });
});
