import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { retryPrintJobAction } from "@/app/restaurant/printing/actions";
import type { AgentContext } from "@/lib/auth/context-types";
import { claimJobs } from "@/lib/data/printing";
import { asSeedUser, invokeAction, seedOnce, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { activeAgent, clearJobs, dataOf, errorOf, testJob, testPrinter, type TestAgent } from "./helpers";

/**
 * TC-PRINT-013 — manual retry and lease recovery (S1-P16-T007, api.md SA-PRN-05, ADR-007 §3–4).
 *
 * Two ways a stuck job gets moving again: a human retrying a terminal failure, and the claim query taking back a
 * lease whose agent never came home. Neither one invents a PRINTED status.
 */
const db = testDb();
const A = tenantIdOf("A");

let agent: TestAgent;
let printerId: string;

beforeAll(async () => {
  await seedOnce();
  agent = await activeAgent("A", { name: "Retry agent" });
  printerId = (await testPrinter("A", { agentId: agent.agentId, name: "Retry printer" })).id;
}, 120_000);

function agentCtx(printerIds: string[]): AgentContext {
  return { kind: "agent", requestId: `test-${randomUUID().slice(0, 8)}`, agentId: agent.agentId, tenantId: A, printerIds };
}

describe("TC-PRINT-013 manual retry (SA-PRN-05)", () => {
  it("resets attempts, schedules immediately, clears the error and the lease, and audits", async () => {
    const job = await testJob("A", printerId, {
      status: "FAILED",
      attemptCount: 3,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1000),
      printAgentId: agent.agentId,
    });
    await db.printJob.update({ where: { id: job.id }, data: { failedAt: new Date(), lastErrorCode: "PRINTER_OFFLINE", lastErrorMessage: "No response" } });

    const { userId } = await asSeedUser("A", "MANAGER");
    const before = Date.now();
    const retried = dataOf(await invokeAction(retryPrintJobAction, { jobId: job.id }));
    expect(retried).toMatchObject({ id: job.id, status: "PENDING", attemptCount: 0, lastErrorCode: null, lastErrorMessage: null });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "PENDING", attemptCount: 0, failedAt: null, claimToken: null, claimedAt: null, leaseExpiresAt: null });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const audits = await db.auditLog.findMany({ where: { action: "print_job.retried", resourceId: job.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, actorUserId: userId, actorRole: "MANAGER" });
    expect(audits[0].beforeState).toMatchObject({ status: "FAILED", attemptCount: 3 });
    expect(audits[0].afterState).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("the retried job is claimable again straight away", async () => {
    await clearJobs("A");
    const job = await testJob("A", printerId, { status: "FAILED", attemptCount: 3, nextAttemptAt: new Date(Date.now() + 3_600_000) });
    await asSeedUser("A", "MANAGER");
    dataOf(await invokeAction(retryPrintJobAction, { jobId: job.id }));

    const claimed = await claimJobs(agentCtx([printerId]), 5, new Date());
    expect(claimed.map((c) => c.jobId)).toEqual([job.id]);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).attemptCount).toBe(1);
  });

  it("refuses to retry a job that is not FAILED (409 NOT_FAILED)", async () => {
    const printed = await testJob("A", printerId, { status: "PRINTED" });
    const pending = await testJob("A", printerId, { status: "PENDING" });
    const processing = await testJob("A", printerId, { status: "PROCESSING", leaseExpiresAt: new Date(Date.now() + 60_000) });

    await asSeedUser("A", "MANAGER");
    for (const id of [printed.id, pending.id, processing.id]) {
      expect(errorOf(await invokeAction(retryPrintJobAction, { jobId: id })).code, id).toBe("NOT_FAILED");
    }
    expect((await db.printJob.findUniqueOrThrow({ where: { id: printed.id } })).status).toBe("PRINTED");
    expect(await db.auditLog.count({ where: { action: "print_job.retried", resourceId: printed.id } })).toBe(0);
  });

  it("TI-045 another tenant's failed job is NOT_FOUND and stays failed", async () => {
    const bPrinter = await testPrinter("B");
    const bJob = await testJob("B", bPrinter.id, { status: "FAILED", attemptCount: 3 });
    await asSeedUser("A", "MANAGER");

    const foreign = errorOf(await invokeAction(retryPrintJobAction, { jobId: bJob.id }));
    const unknown = errorOf(await invokeAction(retryPrintJobAction, { jobId: "5b0c3f1e-9a8d-4c2b-8f7e-6d5c4b3a2f10" }));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign).toEqual(unknown);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: bJob.id } })).status).toBe("FAILED");
  });

  it("WAITER has no print_job:retry", async () => {
    const job = await testJob("A", printerId, { status: "FAILED", attemptCount: 3 });
    await asSeedUser("A", "WAITER");
    expect(await invokeAction(retryPrintJobAction, { jobId: job.id })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
  });
});

describe("TC-PRINT-013 lease recovery", () => {
  it("re-claims a PROCESSING job whose lease expired, and leaves a live lease alone", async () => {
    await clearJobs("A");
    const stranded = await testJob("A", printerId, {
      status: "PROCESSING",
      printAgentId: agent.agentId,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1),
      attemptCount: 1,
    });
    const live = await testJob("A", printerId, {
      status: "PROCESSING",
      printAgentId: agent.agentId,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attemptCount: 1,
    });

    // One lane per printer (2026-10-08): while the live lease runs, this printer gets nothing — the live job is untouched.
    expect(await claimJobs(agentCtx([printerId]), 10, new Date())).toEqual([]);

    // Once the printer is free, the stranded job (expired lease) is taken again with a fresh claim token.
    await db.printJob.update({ where: { id: live.id }, data: { status: "PRINTED", printedAt: new Date(), leaseExpiresAt: null } });
    const claimed = await claimJobs(agentCtx([printerId]), 10, new Date());
    expect(claimed.map((c) => c.jobId)).toEqual([stranded.id]);

    const reclaimed = await db.printJob.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(reclaimed.attemptCount).toBe(2);
    expect(reclaimed.claimToken).toBe(claimed[0].claimToken);
    // The old token is gone, so a crashed agent that wakes up cannot acknowledge the ticket it lost.
    expect(reclaimed.claimToken).not.toBe(stranded.claimToken);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: live.id } })).claimToken).toBe(live.claimToken);
  });

  it("does not resurrect a job that already reached its attempt limit through leases", async () => {
    await clearJobs("A");
    const exhausted = await testJob("A", printerId, { status: "FAILED", attemptCount: 3, leaseExpiresAt: new Date(Date.now() - 1) });
    expect(await claimJobs(agentCtx([printerId]), 10, new Date())).toEqual([]);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: exhausted.id } })).status).toBe("FAILED");
  });
});
