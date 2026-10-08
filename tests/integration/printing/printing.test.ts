import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestPrintJobAction, getPrintJobsAction, getPrintersAction, retryPrintJobAction } from "@/app/restaurant/printing/actions";
import type { ActionResult } from "@/lib/http/action";
import { parsePrintDocument } from "@/lib/print/types";
import { testDb } from "../setup/db";
import { asSeedUser, invokeAction, seedOnce, seeded, tenantIdOf, type ControlFlow, type TenantKey } from "../helpers/actors";

// Printing console retrofit (S1-P04-T007): LD-PRN-01, SA-PRN-04, SA-PRN-05 with session-only tenant and
// security.md §3.3 rows 44–47. Replaces the mocked tests/unit/printing-architecture.test.ts.
const db = testDb();
const RANDOM_UUID = "5b0c3f1e-9a8d-4c2b-8f7e-6d5c4b3a2f10";

beforeAll(seedOnce, 120_000);

function dataOf<T>(result: ActionResult<T> | ControlFlow): T {
  if (!("ok" in result) || !result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
  return result.data;
}

function errorOf(result: ActionResult<unknown> | ControlFlow): { code: string; message: string } {
  if (!("ok" in result) || result.ok) throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
  return { code: result.error.code, message: result.error.message };
}

/** A new FAILED job on the tenant's counter printer, so tests never mutate seeded rows. */
async function freshFailedJob(tenant: TenantKey) {
  return db.printJob.create({
    data: {
      tenantId: tenantIdOf(tenant),
      printerId: seeded(tenant, "printer:counter"),
      jobType: "TEST",
      dedupeKey: `TEST:it-${randomUUID()}`,
      payload: { version: 1, kind: "TEST" },
      status: "FAILED",
      attemptCount: 3,
      failedAt: new Date(),
      lastErrorCode: "PRINTER_OFFLINE",
      lastErrorMessage: "The printer did not respond",
    },
  });
}

async function idsOf(tenant: TenantKey, model: "printJob" | "printer"): Promise<Set<string>> {
  const rows =
    model === "printJob"
      ? await db.printJob.findMany({ where: { tenantId: tenantIdOf(tenant) }, select: { id: true } })
      : await db.printer.findMany({ where: { tenantId: tenantIdOf(tenant) }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

describe("TI-042 the print queue lists only the caller's tenant (LD-PRN-01)", () => {
  it("returns exactly Tenant A's jobs for Tenant A's manager and none of Tenant B's", async () => {
    await asSeedUser("A", "MANAGER");
    const jobs = dataOf(await invokeAction(getPrintJobsAction, {}));
    const [aIds, bIds] = [await idsOf("A", "printJob"), await idsOf("B", "printJob")];
    expect(bIds.size).toBeGreaterThan(0);
    expect(jobs.length).toBe(Math.min(aIds.size, 50));
    expect(jobs.every((j) => aIds.has(j.id))).toBe(true);
    expect(jobs.some((j) => bIds.has(j.id))).toBe(false);
  });

  it("applies the status filter within the tenant", async () => {
    await asSeedUser("A", "MANAGER");
    const failed = dataOf(await invokeAction(getPrintJobsAction, { status: "FAILED" }));
    expect(failed.length).toBe(await db.printJob.count({ where: { tenantId: tenantIdOf("A"), status: "FAILED" } }));
    expect(failed.every((j) => j.status === "FAILED")).toBe(true);
  });

  it("lists only Tenant A's active printers for the test-print dropdown", async () => {
    await asSeedUser("A", "CASHIER");
    const printers = dataOf(await invokeAction(getPrintersAction));
    const expected = await db.printer.findMany({ where: { tenantId: tenantIdOf("A"), isActive: true }, select: { id: true } });
    expect(printers.map((p) => p.id).sort()).toEqual(expected.map((p) => p.id).sort());
    const bIds = await idsOf("B", "printer");
    expect(printers.some((p) => bIds.has(p.id))).toBe(false);
  });

  it("TC-RBAC-146 KITCHEN may read the queue; WAITER is FORBIDDEN (print_job:read)", async () => {
    await asSeedUser("A", "KITCHEN");
    expect(await invokeAction(getPrintJobsAction, {})).toMatchObject({ ok: true });
    await asSeedUser("A", "WAITER");
    expect(await invokeAction(getPrintJobsAction, {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await invokeAction(getPrintersAction)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("ADV-001 rejects a tenantId in the filters (422) instead of honouring it", async () => {
    await asSeedUser("A", "MANAGER");
    const result = await invokeAction(getPrintJobsAction, { tenantId: tenantIdOf("B") } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("TI-045 retry a failed job (SA-PRN-05)", () => {
  it("resets Tenant A's FAILED job to PENDING and audits print_job.retried in the same change", async () => {
    const job = await freshFailedJob("A");
    const { userId } = await asSeedUser("A", "MANAGER");
    const retried = dataOf(await invokeAction(retryPrintJobAction, { jobId: job.id }));
    expect(retried).toMatchObject({ id: job.id, status: "PENDING", attemptCount: 0, lastErrorMessage: null, lastErrorCode: null });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "PENDING", attemptCount: 0, failedAt: null, claimToken: null });
    const audits = await db.auditLog.findMany({ where: { action: "print_job.retried", resourceId: job.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: tenantIdOf("A"), actorUserId: userId, actorRole: "MANAGER" });
    expect(audits[0].beforeState).toMatchObject({ status: "FAILED", attemptCount: 3 });
    expect(audits[0].afterState).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("TC-RBAC-147 KITCHEN may retry; WAITER is FORBIDDEN and the job is unchanged", async () => {
    const job = await freshFailedJob("A");
    await asSeedUser("A", "WAITER");
    expect(await invokeAction(retryPrintJobAction, { jobId: job.id })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");

    await asSeedUser("A", "KITCHEN");
    expect(await invokeAction(retryPrintJobAction, { jobId: job.id })).toMatchObject({ ok: true, data: { status: "PENDING" } });
  });

  it("ADV-002 a Tenant B job id is NOT_FOUND, identical to a random UUID, and Tenant B's job is unchanged", async () => {
    const bJob = await freshFailedJob("B");
    await asSeedUser("A", "MANAGER");
    const foreign = errorOf(await invokeAction(retryPrintJobAction, { jobId: bJob.id }));
    const random = errorOf(await invokeAction(retryPrintJobAction, { jobId: RANDOM_UUID }));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign).toEqual(random);
    const after = await db.printJob.findUniqueOrThrow({ where: { id: bJob.id } });
    expect(after).toMatchObject({ status: "FAILED", attemptCount: 3, lastErrorCode: "PRINTER_OFFLINE" });
    expect(await db.auditLog.count({ where: { action: "print_job.retried", resourceId: bJob.id } })).toBe(0);
  });

  it("refuses to retry a job that is not FAILED (409 NOT_FAILED) and rejects malformed ids (422)", async () => {
    await asSeedUser("A", "MANAGER");
    const printed = await invokeAction(retryPrintJobAction, { jobId: seeded("A", "job:test") });
    expect(printed).toMatchObject({ ok: false, error: { code: "NOT_FAILED" } });
    expect((await db.printJob.findUniqueOrThrow({ where: { id: seeded("A", "job:test") } })).status).toBe("PRINTED");
    expect(await invokeAction(retryPrintJobAction, { jobId: "not-a-uuid" })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("SA-PRN-04 test print", () => {
  it("queues a server-built TEST job on Tenant A's printer and audits print_job.created", async () => {
    const { userId } = await asSeedUser("A", "MANAGER");
    const job = dataOf(await invokeAction(createTestPrintJobAction, { printerId: seeded("A", "printer:counter") }));
    expect(job).toMatchObject({ jobType: "TEST", status: "PENDING", printer: { id: seeded("A", "printer:counter") } });

    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    const restaurant = await db.restaurant.findUniqueOrThrow({ where: { tenantId: tenantIdOf("A") } });
    expect(row).toMatchObject({ tenantId: tenantIdOf("A"), requestedByUserId: userId });
    // S1-P16-T002 replaced the ad-hoc payload with the `PrintDocument` contract the agent renders (architecture.md §6.4).
    const document = parsePrintDocument(row.payload);
    expect(document).toMatchObject({ version: 1, widthMm: 80 });
    expect(JSON.stringify(document)).toContain(restaurant.name);
    expect(JSON.stringify(document)).toContain("PRINTER TEST");
    expect(await db.auditLog.count({ where: { action: "print_job.created", resourceId: job.id, tenantId: tenantIdOf("A") } })).toBe(1);
  });

  it("ADV-002 a Tenant B printer id is NOT_FOUND (same as a random UUID) and no job is created anywhere", async () => {
    await asSeedUser("A", "MANAGER");
    const before = await db.printJob.count();
    const foreign = errorOf(await invokeAction(createTestPrintJobAction, { printerId: seeded("B", "printer:kitchen") }));
    const random = errorOf(await invokeAction(createTestPrintJobAction, { printerId: RANDOM_UUID }));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign).toEqual(random);
    expect(await db.printJob.count()).toBe(before);
  });

  it("TC-RBAC-144 CASHIER is FORBIDDEN (printer:manage) and nothing is queued", async () => {
    await asSeedUser("A", "CASHIER");
    const before = await db.printJob.count({ where: { tenantId: tenantIdOf("A") } });
    const result = await invokeAction(createTestPrintJobAction, { printerId: seeded("A", "printer:counter") });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await db.printJob.count({ where: { tenantId: tenantIdOf("A") } })).toBe(before);
  });

  it("ADV-001 rejects client-supplied payload, job type or tenantId (422)", async () => {
    await asSeedUser("A", "MANAGER");
    const printerId = seeded("A", "printer:counter");
    for (const extra of [{ payload: { raw: "\x1b@" } }, { jobType: "RECEIPT" }, { tenantId: tenantIdOf("B") }]) {
      const result = await invokeAction(createTestPrintJobAction, { printerId, ...extra } as never);
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
  });
});
