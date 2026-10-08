import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as ackRoute } from "@/app/api/v1/print-agent/jobs/[jobId]/ack/route";
import { POST as claimRoute } from "@/app/api/v1/print-agent/jobs/claim/route";
import type { AgentContext } from "@/lib/auth/context-types";
import { ackJob, claimJobs, createPrintJob } from "@/lib/data/printing";
import { seedOnce, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { activeAgent, callAgent, clearJobs, testJob, testPrinter, type TestAgent } from "./helpers";

/**
 * TC-PRINT-003 / TC-PRINT-004 / TC-PRINT-005 — the queue itself (S1-P16-T001, ADR-007 §3–6, BA-22).
 *
 * These run against real PostgreSQL because the guarantees are database guarantees: a unique index for dedupe,
 * `FOR UPDATE SKIP LOCKED` for claiming, and a row lock for acknowledgement.
 */
const db = testDb();
const A = tenantIdOf("A");

let agent: TestAgent;
let otherAgent: TestAgent;
let printerId: string;
/** A KOT job must reference a ticket (`print_jobs_kot_ticket_check`), so the dedupe tests use a seeded one. */
let kotTicketId: string;
let bKotId: string;

async function agentContext(a: TestAgent): Promise<AgentContext> {
  const printers = await db.printer.findMany({ where: { tenantId: a.tenantId, printAgentId: a.agentId, isActive: true }, select: { id: true } });
  return { kind: "agent", requestId: `test-${randomUUID().slice(0, 8)}`, agentId: a.agentId, tenantId: a.tenantId, printerIds: printers.map((p) => p.id) };
}

/** A TenantContext good enough for the data layer (it reads only `tenantId` and `userId`). */
const tenantCtx = { kind: "tenant", requestId: "test-queue", tenantId: A, userId: null } as never;

beforeAll(async () => {
  await seedOnce();
  agent = await activeAgent("A", { name: "Queue agent" });
  otherAgent = await activeAgent("A", { name: "Second agent" });
  const printer = await testPrinter("A", { agentId: agent.agentId, name: "Queue printer" });
  printerId = printer.id;
  // Both agents serve the same printer, which is what makes the concurrency test meaningful.
  await db.printer.update({ where: { id: printer.id }, data: { printAgentId: agent.agentId } });
  kotTicketId = (await db.kotTicket.findFirstOrThrow({ where: { tenantId: A } })).id;
  bKotId = (await db.kotTicket.findFirstOrThrow({ where: { tenantId: tenantIdOf("B") } })).id;
}, 120_000);

describe("TC-PRINT-003 dedupe on creation (SC-PRINT-05)", () => {
  it("returns the existing job and inserts nothing for a repeated dedupe key", async () => {
    const dedupeKey = `KOT:${randomUUID()}:v1`;
    const payload = { version: 1 as const, widthMm: 80 as const, blocks: [{ type: "text" as const, text: "Ticket" }] };

    const first = await db.$transaction((tx) => createPrintJob(tx, tenantCtx, { printerId, jobType: "KOT", dedupeKey, payload, kotTicketId }));
    const before = await db.printJob.count({ where: { tenantId: A } });
    const second = await db.$transaction((tx) => createPrintJob(tx, tenantCtx, { printerId, jobType: "KOT", dedupeKey, payload, kotTicketId }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await db.printJob.count({ where: { tenantId: A } })).toBe(before);
    expect(await db.printJob.count({ where: { tenantId: A, dedupeKey } })).toBe(1);
  });

  it("does not abort the surrounding transaction when the key is taken", async () => {
    const dedupeKey = `KOT:${randomUUID()}:v1`;
    const payload = { version: 1 as const, widthMm: 80 as const, blocks: [{ type: "text" as const, text: "Ticket" }] };
    await db.$transaction((tx) => createPrintJob(tx, tenantCtx, { printerId, jobType: "KOT", dedupeKey, payload, kotTicketId }));

    // The business write after the duplicate must still commit — this is the KOT acceptance path (BR-PRINT dedupe).
    const marker = await db.$transaction(async (tx) => {
      await createPrintJob(tx, tenantCtx, { printerId, jobType: "KOT", dedupeKey, payload, kotTicketId });
      return createPrintJob(tx, tenantCtx, { printerId, jobType: "TEST", dedupeKey: `TEST:${randomUUID()}`, payload });
    });
    expect(marker.created).toBe(true);
    expect(await db.printJob.findUnique({ where: { id: marker.id } })).not.toBeNull();
  });

  it("lets two tenants use the same dedupe key (it is unique per tenant, not globally)", async () => {
    const dedupeKey = `KOT:${randomUUID()}:v1`;
    const payload = { version: 1 as const, widthMm: 80 as const, blocks: [{ type: "text" as const, text: "Ticket" }] };
    const bPrinter = await testPrinter("B");
    const bCtx = { kind: "tenant", requestId: "test-queue-b", tenantId: tenantIdOf("B"), userId: null } as never;

    const a = await db.$transaction((tx) => createPrintJob(tx, tenantCtx, { printerId, jobType: "KOT", dedupeKey, payload, kotTicketId }));
    const b = await db.$transaction((tx) => createPrintJob(tx, bCtx, { printerId: bPrinter.id, jobType: "KOT", dedupeKey, payload, kotTicketId: bKotId }));
    expect(a.created && b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});

describe("TC-PRINT-004 atomic claiming (SC-PRINT-03, BA-22)", () => {
  it("10 concurrent claims by two agents never return the same job twice", async () => {
    await clearJobs("A");
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(await testJob("A", printerId, { dedupeKey: `TEST:race-${i}-${randomUUID()}` }));

    const [ctxOne, ctxTwo] = await Promise.all([agentContext(agent), agentContext(otherAgent)]);
    // The second agent serves the same printer, so both are eligible for every row.
    const ctxTwoSamePrinter: AgentContext = { ...ctxTwo, printerIds: ctxOne.printerIds };

    const at = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => claimJobs(index % 2 === 0 ? ctxOne : ctxTwoSamePrinter, 2, at)),
    );

    const claimed = results.flat();
    const ids = claimed.map((job) => job.jobId);
    expect(new Set(ids).size, "no job was claimed twice").toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(claimed.map((job) => job.claimToken)).size).toBe(claimed.length);

    const rows = await db.printJob.findMany({ where: { tenantId: A, id: { in: ids } } });
    expect(rows.every((row) => row.status === "PROCESSING" && row.attemptCount === 1 && row.leaseExpiresAt !== null)).toBe(true);
    expect(rows.every((row) => row.leaseExpiresAt!.getTime() - at.getTime() === 60_000), "lease is 60 s").toBe(true);
  }, 60_000);

  it("leaves a job alone until it is due, and returns an expired lease to the queue", async () => {
    await clearJobs("A");
    const ctx = await agentContext(agent);
    const future = await testJob("A", printerId, { nextAttemptAt: new Date(Date.now() + 60_000) });
    expect(await claimJobs(ctx, 5, new Date())).toEqual([]);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: future.id } })).status).toBe("PENDING");

    const stranded = await testJob("A", printerId, {
      status: "PROCESSING",
      printAgentId: otherAgent.agentId,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1000),
      attemptCount: 1,
    });
    const reclaimed = await claimJobs(ctx, 5, new Date());
    expect(reclaimed.map((job) => job.jobId)).toEqual([stranded.id]);

    const row = await db.printJob.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(row.printAgentId).toBe(agent.agentId);
    expect(row.attemptCount).toBe(2);
    expect(row.claimToken).not.toBeNull();
    expect(row.claimToken).toBe(reclaimed[0].claimToken);
  });

  it("claims nothing for an agent with no printers, and never another agent's printer", async () => {
    await clearJobs("A");
    await testJob("A", printerId);
    const orphan = await activeAgent("A", { name: "Unassigned agent" });
    expect(await claimJobs(await agentContext(orphan), 5, new Date())).toEqual([]);
  });

  it("one lane per printer: at most one job per printer per claim, in order (printing audit 2026-10-08)", async () => {
    await clearJobs("A");
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await testJob("A", printerId, { dedupeKey: `TEST:lane-${i}-${randomUUID()}` }));
    const ctx = await agentContext(agent);
    const first = await claimJobs(ctx, 10, new Date());
    expect(first.map((job) => job.jobId)).toEqual([jobs[0].id]);
    // While that job is in flight under a live lease, the printer gets nothing else.
    expect(await claimJobs(ctx, 10, new Date())).toEqual([]);
  });

  it("respects the 1–10 bound on `max` across printers", async () => {
    await clearJobs("A");
    const lanes = [];
    for (let i = 0; i < 12; i++) {
      const printer = await testPrinter("A", { agentId: agent.agentId, name: `Lane ${i} ${randomUUID().slice(0, 4)}` });
      lanes.push(printer.id);
      await testJob("A", printer.id, { dedupeKey: `TEST:bound-${i}-${randomUUID()}` });
    }
    const ctx = await agentContext(agent);
    const claimed = await claimJobs(ctx, 100, new Date());
    expect(claimed.length).toBe(10);
    expect(new Set(claimed.map((job) => job.printerId)).size).toBe(10);
    await db.printJob.deleteMany({ where: { printerId: { in: lanes } } });
    await db.printer.deleteMany({ where: { id: { in: lanes } } });
  });
});

describe("TC-PRINT-005 acknowledgement (SC-PRINT-04, ADR-007 §4)", () => {
  async function claimedJob(): Promise<{ jobId: string; claimToken: string; ctx: AgentContext }> {
    await clearJobs("A");
    await testJob("A", printerId, { dedupeKey: `TEST:ack-${randomUUID()}` });
    const ctx = await agentContext(agent);
    const [claimed] = await claimJobs(ctx, 1, new Date());
    return { jobId: claimed.jobId, claimToken: claimed.claimToken, ctx };
  }

  it("marks a job PRINTED only on an acknowledgement from the owning agent", async () => {
    const { jobId, claimToken, ctx } = await claimedJob();
    const result = await ackJob(ctx, jobId, claimToken, { result: "PRINTED" }, new Date());
    expect(result).toMatchObject({ status: "PRINTED", changed: true, terminalFailure: false });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe("PRINTED");
    expect(row.printedAt).not.toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("repeating the identical acknowledgement returns the job unchanged", async () => {
    const { jobId, claimToken, ctx } = await claimedJob();
    await ackJob(ctx, jobId, claimToken, { result: "PRINTED" }, new Date());
    const printedAt = (await db.printJob.findUniqueOrThrow({ where: { id: jobId } })).printedAt;

    const again = await ackJob(ctx, jobId, claimToken, { result: "PRINTED" }, new Date(Date.now() + 5_000));
    expect(again).toMatchObject({ status: "PRINTED", changed: false });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: jobId } })).printedAt).toEqual(printedAt);
  });

  it("a stale claim token is 409 STALE_CLAIM and changes nothing", async () => {
    const { jobId, ctx } = await claimedJob();
    await expect(ackJob(ctx, jobId, randomUUID(), { result: "PRINTED" }, new Date())).rejects.toMatchObject({ code: "STALE_CLAIM", statusCode: 409 });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("PROCESSING");
  });

  it("another agent's acknowledgement is 404, identical to an unknown job id", async () => {
    const { jobId, claimToken } = await claimedJob();
    const intruder = await agentContext(otherAgent);
    await expect(ackJob(intruder, jobId, claimToken, { result: "PRINTED" }, new Date())).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(ackJob(intruder, randomUUID(), claimToken, { result: "PRINTED" }, new Date())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("PROCESSING");
  });

  it("a failure retries with backoff while attempts remain, then goes terminal FAILED", async () => {
    await clearJobs("A");
    await testJob("A", printerId, { dedupeKey: `TEST:backoff-${randomUUID()}`, maxAttempts: 2 });
    const ctx = await agentContext(agent);

    const at = new Date();
    const [first] = await claimJobs(ctx, 1, at);
    const failedOnce = await ackJob(ctx, first.jobId, first.claimToken, { result: "FAILED", errorCode: "PRINTER_OFFLINE", errorMessage: "No response" }, at);
    expect(failedOnce).toMatchObject({ status: "PENDING", terminalFailure: false });

    const requeued = await db.printJob.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(requeued.attemptCount).toBe(1);
    expect(requeued.lastErrorCode).toBe("PRINTER_UNREACHABLE"); // an older agent's code, normalised
    expect(requeued.nextAttemptAt.getTime() - at.getTime()).toBe(5_000); // test pages: 5 s, then give up
    expect(requeued.leaseExpiresAt).toBeNull();

    const later = new Date(at.getTime() + 6_000);
    const [second] = await claimJobs(ctx, 1, later);
    expect(second.jobId).toBe(first.jobId);
    const terminal = await ackJob(ctx, second.jobId, second.claimToken, { result: "FAILED", errorCode: "PRINTER_OFFLINE" }, later);
    expect(terminal).toMatchObject({ status: "FAILED", terminalFailure: true });

    const finalRow = await db.printJob.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(finalRow).toMatchObject({ status: "FAILED", attemptCount: 2 });
    expect(finalRow.failedAt).not.toBeNull();
  });

  it("refuses to reopen a settled job with a different outcome", async () => {
    const { jobId, claimToken, ctx } = await claimedJob();
    await ackJob(ctx, jobId, claimToken, { result: "PRINTED" }, new Date());
    await expect(ackJob(ctx, jobId, claimToken, { result: "FAILED", errorCode: "PAPER_OUT" }, new Date())).rejects.toMatchObject({ code: "ALREADY_ACKNOWLEDGED" });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("PRINTED");
  });

  it("a PRINTED acknowledgement for a job that was never claimed is refused", async () => {
    await clearJobs("A");
    const job = await testJob("A", printerId, { dedupeKey: `TEST:unclaimed-${randomUUID()}` });
    const ctx = await agentContext(agent);
    await expect(ackJob(ctx, job.id, randomUUID(), { result: "PRINTED" }, new Date())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PENDING");
  });
});

describe("RH-AGT-03 / RH-AGT-04 over HTTP", () => {
  it("claims and acknowledges through the route handlers", async () => {
    await clearJobs("A");
    await testJob("A", printerId, { dedupeKey: `TEST:http-${randomUUID()}` });

    const claim = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 1 }, token: agent.token });
    expect(claim.status).toBe(200);
    const body = claim.body as { jobs: Array<{ jobId: string; claimToken: string; payload: unknown; leaseExpiresAt: string }> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].payload).toMatchObject({ version: 1 });

    const ack = await callAgent(ackRoute, {
      url: `/api/v1/print-agent/jobs/${body.jobs[0].jobId}/ack`,
      params: { jobId: body.jobs[0].jobId },
      body: { claimToken: body.jobs[0].claimToken, result: "PRINTED" },
      token: agent.token,
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: "PRINTED" });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: body.jobs[0].jobId } })).status).toBe("PRINTED");
  });

  it("rejects a body carrying a tenant id or any other unknown field with 422", async () => {
    for (const body of [{ max: 1, tenantId: tenantIdOf("B") }, { max: 1, printerId }, { max: 1, unexpected: true }]) {
      const response = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body, token: agent.token });
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("rejects a malformed body and an out-of-range max", async () => {
    const malformed = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: "not-json" as never, token: agent.token });
    expect([400, 422]).toContain(malformed.status);
    const tooMany = await callAgent(claimRoute, { url: "/api/v1/print-agent/jobs/claim", body: { max: 99 }, token: agent.token });
    expect(tooMany.status).toBe(422);
  });
});
