import "server-only";
import { PrintAgentStatus, PrintJobStatus, PrintJobType, PrinterCheckStatus, PrinterConnection, PrinterDiscoveryStatus, PrinterHealth, PrinterPurpose, Prisma } from "@prisma/client";
import type { AgentContext, TenantContext, TenantScopedContext } from "@/lib/auth/context-types";
import { db } from "@/lib/db/prisma";
import { ConflictError } from "@/lib/errors";
import { canonicalPrintErrorCode } from "@/lib/print/error-codes";
import { LEASE_MS, RETRY_POLICIES, displayStatus, outcomeOfFailure, type PrintJobDisplayStatus } from "@/lib/print/state-machine";
import type { PrintDocument } from "@/lib/print/types";
import { instantDto, nullableInstantDto } from "./dto";
import { mapErrors } from "./errors";
import { required, tenantKey, tenantScope } from "./scope";
import type { Tx } from "./tx";

/**
 * Print queue, printer and agent data access (S1-P16-T001/T004, ADR-004, ADR-007; replaces the baseline queue code in
 * `lib/services/printing.ts`, BA-01/BA-22).
 *
 * Three rules hold for every function here:
 * 1. The tenant always comes from the context — a `TenantContext` for staff, an `AgentContext` whose `tenantId` was
 *    read from the PRINT_AGENT row the bearer token resolved to (ADR-007 §1, SC-TEN-07).
 * 2. Claiming is one atomic statement (`FOR UPDATE SKIP LOCKED` + `RETURNING`), so two agents polling at the same
 *    instant can never take the same job (SC-PRINT-03, TC-PRINT-004).
 * 3. `PRINTED` is written in exactly one place — `ackJob` — and only for a PROCESSING job of the acknowledging agent
 *    whose claim token matches (BR-PRINT-01, SC-PRINT-04, TC-PRINT-006).
 *
 * Two lookups are deliberately *not* tenant-scoped, because they are the step that establishes the tenant: resolving a
 * pairing code hash and resolving a bearer-token hash. Both columns are globally unique and both take the tenant from
 * the row they find, never from the request.
 */

// ─── Projections ───

export type PrintJobDto = {
  id: string;
  jobType: PrintJobType;
  status: PrintJobStatus;
  orderId: string | null;
  kotTicketId: string | null;
  isReprint: boolean;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  printedAt: string | null;
  nextAttemptAt: string;
  /** What staff see: QUEUED, PRINTING, RETRYING, DELIVERED, FAILED or CANCELLED (lib/print/state-machine.ts). */
  displayStatus: PrintJobDisplayStatus;
  cancelReason: string | null;
  printer: { id: string; name: string };
  orderNumber: string | null;
  kotNumber: string | null;
};

export type PrinterDto = {
  id: string;
  name: string;
  purpose: PrinterPurpose;
  connectionType: PrinterConnection;
  /** Null for callers without `printer:manage`: the console's queue view never needs a device address (LD-PRN-01). */
  connectionAddress: string | null;
  paperWidthMm: number;
  isActive: boolean;
  health: PrinterHealth;
  healthReportedAt: string | null;
  kitchenSectionId: string | null;
  kitchenSectionName: string | null;
  printAgentId: string | null;
  printAgentName: string | null;
  printAgentStatus: PrintAgentStatus | null;
  /** Capability profile key (lib/print/profiles.ts). */
  profile: string;
  archivedAt: string | null;
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastErrorCode: string | null;
};

export type PrintAgentDto = {
  id: string;
  name: string;
  status: PrintAgentStatus;
  /** Null for callers without `print_agent:manage`: only the pairing screen needs to identify a token. */
  tokenPrefix: string | null;
  agentVersion: string | null;
  osInfo: string | null;
  lastSeenAt: string | null;
  pairedAt: string | null;
  pairingExpiresAt: string | null;
  revokedAt: string | null;
};

const JOB_SELECT = {
  id: true,
  jobType: true,
  status: true,
  orderId: true,
  kotTicketId: true,
  isReprint: true,
  attemptCount: true,
  maxAttempts: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
  printedAt: true,
  nextAttemptAt: true,
  cancelReason: true,
  printer: { select: { id: true, name: true } },
  order: { select: { orderNumber: true } },
  kotTicket: { select: { kotNumber: true } },
} satisfies Prisma.PrintJobSelect;

type JobRow = Prisma.PrintJobGetPayload<{ select: typeof JOB_SELECT }>;

function toJobDto(row: JobRow): PrintJobDto {
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status,
    orderId: row.orderId,
    kotTicketId: row.kotTicketId,
    isReprint: row.isReprint,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: instantDto(row.createdAt),
    updatedAt: instantDto(row.updatedAt),
    printedAt: nullableInstantDto(row.printedAt),
    nextAttemptAt: instantDto(row.nextAttemptAt),
    displayStatus: displayStatus(row),
    cancelReason: row.cancelReason,
    printer: row.printer,
    orderNumber: row.order?.orderNumber ?? null,
    kotNumber: row.kotTicket?.kotNumber ?? null,
  };
}

const PRINTER_SELECT = {
  id: true,
  name: true,
  purpose: true,
  connectionType: true,
  connectionAddress: true,
  paperWidthMm: true,
  isActive: true,
  health: true,
  healthReportedAt: true,
  kitchenSectionId: true,
  printAgentId: true,
  kitchenSection: { select: { name: true } },
  printAgent: { select: { name: true, status: true } },
  profile: true,
  archivedAt: true,
  lastDeliveredAt: true,
  lastFailedAt: true,
  lastErrorCode: true,
} satisfies Prisma.PrinterSelect;

type PrinterRow = Prisma.PrinterGetPayload<{ select: typeof PRINTER_SELECT }>;

/** The stored row: `connection_address` is NOT NULL, so writes and single-row reads always carry it. */
export type PrinterRowDto = PrinterDto & { connectionAddress: string };

function toPrinterDto(row: PrinterRow): PrinterRowDto {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    connectionType: row.connectionType,
    connectionAddress: row.connectionAddress,
    paperWidthMm: row.paperWidthMm,
    isActive: row.isActive,
    health: row.health,
    healthReportedAt: nullableInstantDto(row.healthReportedAt),
    kitchenSectionId: row.kitchenSectionId,
    kitchenSectionName: row.kitchenSection?.name ?? null,
    printAgentId: row.printAgentId,
    printAgentName: row.printAgent?.name ?? null,
    printAgentStatus: row.printAgent?.status ?? null,
    profile: row.profile,
    archivedAt: nullableInstantDto(row.archivedAt),
    lastDeliveredAt: nullableInstantDto(row.lastDeliveredAt),
    lastFailedAt: nullableInstantDto(row.lastFailedAt),
    lastErrorCode: row.lastErrorCode,
  };
}

const AGENT_SELECT = {
  id: true,
  name: true,
  status: true,
  tokenPrefix: true,
  agentVersion: true,
  osInfo: true,
  lastSeenAt: true,
  pairedAt: true,
  pairingExpiresAt: true,
  revokedAt: true,
} satisfies Prisma.PrintAgentSelect;

type AgentRow = Prisma.PrintAgentGetPayload<{ select: typeof AGENT_SELECT }>;

function toAgentDto(row: AgentRow): PrintAgentDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    tokenPrefix: row.tokenPrefix,
    agentVersion: row.agentVersion,
    osInfo: row.osInfo,
    lastSeenAt: nullableInstantDto(row.lastSeenAt),
    pairedAt: nullableInstantDto(row.pairedAt),
    pairingExpiresAt: nullableInstantDto(row.pairingExpiresAt),
    revokedAt: nullableInstantDto(row.revokedAt),
  };
}

// ─── Console reads (LD-PRN-01, RH-PRN-01) ───

export type PrintJobFilters = { status?: PrintJobStatus; jobType?: PrintJobType; since?: Date };

export async function listPrintJobs(ctx: TenantContext, filters: PrintJobFilters = {}, limit = 50): Promise<PrintJobDto[]> {
  const rows = await mapErrors("Print job", () =>
    db.printJob.findMany({
      where: tenantScope(ctx, {
        // Archived jobs have left the history view (RASOIOS-ADR-022); the rows themselves are kept.
        archivedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.jobType ? { jobType: filters.jobType } : {}),
        ...(filters.since ? { updatedAt: { gte: filters.since } } : {}),
      }),
      select: JOB_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: Math.min(Math.max(1, limit), 100),
    }),
  );
  return rows.map(toJobDto);
}

export async function countPrintJobs(ctx: TenantContext, status: PrintJobStatus): Promise<number> {
  return mapErrors("Print job", () => db.printJob.count({ where: tenantScope(ctx, { status, archivedAt: null }) }));
}

/**
 * Removes finished jobs (PRINTED or FAILED) from the history view — by id, or everything queued before `before`.
 * A job still waiting for or at the printer is never matched (and a database CHECK refuses it anyway). Returns the ids.
 */
export async function archivePrintJobs(client: Tx, ctx: TenantContext, target: { jobIds: string[] } | { before: Date }): Promise<string[]> {
  const where = tenantScope(ctx, {
    archivedAt: null,
    status: { in: [PrintJobStatus.PRINTED, PrintJobStatus.FAILED, PrintJobStatus.CANCELLED] },
    ...("jobIds" in target ? { id: { in: target.jobIds } } : { createdAt: { lt: target.before } }),
  });
  const rows = await client.printJob.findMany({ where: tenantScope(ctx, where), select: { id: true } });
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await client.printJob.updateMany({ where: tenantScope(ctx, { id: { in: ids }, archivedAt: null }), data: { archivedAt: new Date(), archivedByUserId: ctx.userId } });
  }
  return ids;
}

/** Every printer of the caller's tenant, active first, newest name order — the console shows inactive ones too. */
export async function listPrinters(ctx: TenantContext): Promise<PrinterDto[]> {
  const rows = await mapErrors("Printer", () =>
    db.printer.findMany({ where: tenantScope(ctx), select: PRINTER_SELECT, orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }] }),
  );
  return rows.map(toPrinterDto);
}

export async function listActivePrinters(ctx: TenantContext): Promise<PrinterDto[]> {
  const rows = await mapErrors("Printer", () =>
    db.printer.findMany({ where: tenantScope(ctx, { isActive: true }), select: PRINTER_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }] }),
  );
  return rows.map(toPrinterDto);
}

export async function listPrintAgents(ctx: TenantContext): Promise<PrintAgentDto[]> {
  const rows = await mapErrors("Print agent", () =>
    db.printAgent.findMany({ where: tenantScope(ctx), select: AGENT_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  );
  return rows.map(toAgentDto);
}

export async function findPrintJobById(ctx: TenantScopedContext, jobId: string): Promise<PrintJobDto | null> {
  const row = await mapErrors("Print job", () => db.printJob.findUnique({ where: tenantKey(ctx, jobId), select: JOB_SELECT }));
  return row ? toJobDto(row) : null;
}

async function jobDtoIn(client: Tx, ctx: TenantScopedContext, jobId: string): Promise<PrintJobDto> {
  return toJobDto(required(await client.printJob.findUnique({ where: tenantKey(ctx, jobId), select: JOB_SELECT }), "Print job"));
}

/** The restaurant fields a ticket or receipt prints, plus the auto-print switch (E02). */
export type PrintingProfile = {
  name: string;
  autoPrintKot: boolean;
  gstin: string | null;
  receiptFooter: string | null;
  addressLines: string[];
  phoneE164: string | null;
  timezone: string;
  currencyCode: string;
};

export async function printingProfile(client: Tx, ctx: TenantContext): Promise<PrintingProfile> {
  const row = required(
    await client.restaurant.findUnique({
      where: { tenantId: ctx.tenantId },
      select: {
        name: true,
        autoPrintKot: true,
        gstin: true,
        receiptFooter: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        phoneE164: true,
        timezone: true,
        currencyCode: true,
      },
    }),
    "Restaurant",
  );
  const locality = [row.city, row.region, row.postalCode].filter((part): part is string => Boolean(part)).join(" ");
  return {
    name: row.name,
    autoPrintKot: row.autoPrintKot,
    gstin: row.gstin,
    receiptFooter: row.receiptFooter,
    addressLines: [row.addressLine1, row.addressLine2, locality || null].filter((part): part is string => Boolean(part)),
    phoneE164: row.phoneE164,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
  };
}

// ─── Printer routing (architecture.md §6.2) ───

const KOT_PURPOSES: PrinterPurpose[] = [PrinterPurpose.KOT, PrinterPurpose.KOT_AND_RECEIPT];
const RECEIPT_PURPOSES: PrinterPurpose[] = [PrinterPurpose.RECEIPT, PrinterPurpose.KOT_AND_RECEIPT];

export type PrinterTarget = { id: string; name: string; paperWidthMm: number };

const TARGET_SELECT = { id: true, name: true, paperWidthMm: true } satisfies Prisma.PrinterSelect;

/**
 * The printer a section's KOT goes to: the section's own active KOT printer, else an active KOT printer with no
 * section, else none — in which case no job is created and the ticket reads `printStatus: NONE`.
 */
export async function resolveKotPrinter(client: Tx, ctx: TenantContext, kitchenSectionId: string | null): Promise<PrinterTarget | null> {
  if (kitchenSectionId) {
    const sectionPrinter = await client.printer.findFirst({
      where: tenantScope(ctx, { isActive: true, kitchenSectionId, purpose: { in: KOT_PURPOSES } }),
      select: TARGET_SELECT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    if (sectionPrinter) return sectionPrinter;
  }
  return client.printer.findFirst({
    where: tenantScope(ctx, { isActive: true, kitchenSectionId: null, purpose: { in: KOT_PURPOSES } }),
    select: TARGET_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** The first active RECEIPT-capable printer by name (api.md SA-PRN-06). */
export async function resolveReceiptPrinter(client: Tx, ctx: TenantContext): Promise<PrinterTarget | null> {
  return client.printer.findFirst({
    where: tenantScope(ctx, { isActive: true, purpose: { in: RECEIPT_PURPOSES } }),
    select: TARGET_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function findPrinterTarget(client: Tx, ctx: TenantContext, printerId: string, options: { activeOnly?: boolean } = {}): Promise<PrinterTarget | null> {
  return client.printer.findFirst({
    where: tenantScope(ctx, { id: printerId, ...(options.activeOnly === false ? {} : { isActive: true }) }),
    select: TARGET_SELECT,
  });
}

// ─── Job creation with dedupe (SC-PRINT-05) ───

export type NewPrintJob = {
  printerId: string;
  jobType: PrintJobType;
  dedupeKey: string;
  payload: PrintDocument;
  orderId?: string | null;
  kotTicketId?: string | null;
  isReprint?: boolean;
  requestedByUserId?: string | null;
  maxAttempts?: number;
};

export type CreatedPrintJob = { id: string; created: boolean };

/**
 * Inserts a job, or returns the existing one when `(tenant_id, dedupe_key)` is already taken (ADR-007 §6). A plain
 * `create` would abort the surrounding transaction on the unique violation — and KOT jobs are created inside the
 * order's acceptance transaction — so the insert is `ON CONFLICT DO NOTHING` and the loser reads the winner's row.
 */
export async function createPrintJob(client: Tx, ctx: TenantContext, job: NewPrintJob): Promise<CreatedPrintJob> {
  const inserted = await client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO print_jobs (tenant_id, printer_id, job_type, order_id, kot_ticket_id, dedupe_key, is_reprint, payload, status, attempt_count, max_attempts, next_attempt_at, requested_by_user_id, created_at, updated_at)
    VALUES (
      ${ctx.tenantId}::uuid,
      ${job.printerId}::uuid,
      ${job.jobType}::print_job_type,
      ${job.orderId ?? null}::uuid,
      ${job.kotTicketId ?? null}::uuid,
      ${job.dedupeKey},
      ${job.isReprint ?? false},
      ${JSON.stringify(job.payload)}::jsonb,
      'PENDING'::print_job_status,
      0,
      ${job.maxAttempts ?? RETRY_POLICIES[job.jobType].maxAttempts},
      now(),
      ${job.requestedByUserId ?? null}::uuid,
      now(),
      now()
    )
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING id`;
  if (inserted.length > 0) return { id: inserted[0].id, created: true };

  const existing = required(
    await client.printJob.findFirst({ where: tenantScope(ctx, { dedupeKey: job.dedupeKey }), select: { id: true } }),
    "Print job",
  );
  return { id: existing.id, created: false };
}

/** How many reprints of a ticket already exist, so the next dedupe key is `KOT:{id}:reprint:{n}` (api.md SA-KOT-02). */
export type KotDispatchRow = {
  kotTicketId: string;
  kotNumber: string;
  sectionName: string | null;
  job: { status: PrintJobStatus; printerName: string; agentStatus: PrintAgentStatus | null; agentLastSeenAt: string | null } | null;
};

/**
 * Where each kitchen ticket of an order went (round `round`): its original, non-reprint print job and the printer's
 * agent liveness. Tenant-scoped through the order and every relation. Used to tell the person who placed the order
 * what actually happened to the KOT, instead of assuming it printed.
 */
export async function kotDispatchOfOrder(client: Tx, ctx: TenantContext, orderId: string, round: number): Promise<KotDispatchRow[]> {
  const tickets = await client.kotTicket.findMany({
    where: tenantScope(ctx, { orderId, roundNumber: round }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kotNumber: true,
      kitchenSection: { select: { name: true } },
      printJobs: {
        where: { tenantId: ctx.tenantId, jobType: PrintJobType.KOT, isReprint: false },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { status: true, printer: { select: { name: true, printAgent: { select: { status: true, lastSeenAt: true } } } } },
      },
    },
  });
  return tickets.map((ticket) => {
    const job = ticket.printJobs[0];
    return {
      kotTicketId: ticket.id,
      kotNumber: ticket.kotNumber,
      sectionName: ticket.kitchenSection?.name ?? null,
      job: job
        ? {
            status: job.status,
            printerName: job.printer.name,
            agentStatus: job.printer.printAgent?.status ?? null,
            agentLastSeenAt: nullableInstantDto(job.printer.printAgent?.lastSeenAt ?? null),
          }
        : null,
    };
  });
}

export async function countKotReprints(client: Tx, ctx: TenantContext, kotTicketId: string): Promise<number> {
  return client.printJob.count({ where: tenantScope(ctx, { kotTicketId, jobType: PrintJobType.KOT, isReprint: true }) });
}

/** How many receipt jobs an order already has, so the next dedupe key is `RECEIPT:{orderId}:v{n}`. */
export async function countReceiptJobs(client: Tx, ctx: TenantContext, orderId: string): Promise<number> {
  return client.printJob.count({ where: tenantScope(ctx, { orderId, jobType: PrintJobType.RECEIPT }) });
}

export async function getPrintJob(client: Tx, ctx: TenantScopedContext, jobId: string): Promise<PrintJobDto> {
  return jobDtoIn(client, ctx, jobId);
}

// ─── Claiming (RH-AGT-03, ADR-007 §3) ───

export type ClaimedJob = {
  jobId: string;
  claimToken: string;
  printerId: string;
  jobType: PrintJobType;
  payload: unknown;
  leaseExpiresAt: string;
  attemptCount: number;
};

type ClaimRow = {
  id: string;
  claim_token: string;
  printer_id: string;
  job_type: PrintJobType;
  payload: unknown;
  lease_expires_at: Date;
  attempt_count: number;
};

/**
 * One statement claims up to `max` jobs for the calling agent: the CTE locks the due rows with
 * `FOR UPDATE SKIP LOCKED` and the UPDATE leases them in the same snapshot, so a second agent polling concurrently
 * skips the locked rows instead of taking them again (SC-PRINT-03, TC-PRINT-004, BA-22).
 *
 * Claimable = PENDING and due, or PROCESSING with an expired lease (a crashed agent's jobs return to the queue,
 * S1-P16-T007). Both are restricted to the agent's own tenant *and* the printers assigned to that agent.
 *
 * One lane per printer (printing audit 2026-10-08 P1): at most one job per printer per claim — that printer's oldest
 * due job — and none for a printer that already has a job in flight under a live lease. A dead printer therefore holds
 * at most one lease and never takes another printer's turn; a printer's own tickets go out in order.
 */
export async function claimJobs(ctx: AgentContext, max: number, at: Date): Promise<ClaimedJob[]> {
  if (ctx.printerIds.length === 0) return [];
  const leaseExpiresAt = new Date(at.getTime() + LEASE_MS);
  const rows = await mapErrors("Print job", () =>
    db.$queryRaw<ClaimRow[]>`
      WITH firsts AS (
        SELECT DISTINCT ON (j.printer_id) j.id
        FROM print_jobs j
        WHERE j.tenant_id = ${ctx.tenantId}::uuid
          AND j.printer_id = ANY(${[...ctx.printerIds]}::uuid[])
          AND (
            (j.status = 'PENDING' AND j.next_attempt_at <= ${at})
            OR (j.status = 'PROCESSING' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < ${at})
          )
          AND NOT EXISTS (
            SELECT 1 FROM print_jobs busy
            WHERE busy.tenant_id = j.tenant_id
              AND busy.printer_id = j.printer_id
              AND busy.status = 'PROCESSING'
              AND busy.lease_expires_at >= ${at}
          )
        ORDER BY j.printer_id, j.created_at, j.id
      ),
      claimable AS (
        SELECT id
        FROM print_jobs
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND id IN (SELECT id FROM firsts)
          AND (
            (status = 'PENDING' AND next_attempt_at <= ${at})
            OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < ${at})
          )
        ORDER BY created_at, id
        LIMIT ${Math.min(Math.max(1, max), 10)}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE print_jobs j
      SET status = 'PROCESSING'::print_job_status,
          print_agent_id = ${ctx.agentId}::uuid,
          claimed_at = ${at},
          lease_expires_at = ${leaseExpiresAt},
          attempt_count = j.attempt_count + 1,
          claim_token = gen_random_uuid(),
          updated_at = now()
      FROM claimable c
      WHERE j.id = c.id AND j.tenant_id = ${ctx.tenantId}::uuid
      RETURNING j.id, j.claim_token, j.printer_id, j.job_type, j.payload, j.lease_expires_at, j.attempt_count`,
  );

  return rows.map((row) => ({
    jobId: row.id,
    claimToken: row.claim_token,
    printerId: row.printer_id,
    jobType: row.job_type,
    payload: row.payload,
    leaseExpiresAt: instantDto(row.lease_expires_at),
    attemptCount: Number(row.attempt_count),
  }));
}

// ─── Acknowledgement (RH-AGT-04, ADR-007 §4) ───

export type AckResult = {
  jobId: string;
  status: PrintJobStatus;
  attemptCount: number;
  /** False when the ack repeated one already applied (idempotent, api.md RH-AGT-04). */
  changed: boolean;
  /** True when this ack moved the job to terminal FAILED, which the caller audits as `print_job.failed`. */
  terminalFailure: boolean;
  /** The catalogue code recorded on the job (lib/print/error-codes.ts); null for a delivery. */
  errorCode: string | null;
};

export type AckInput = { result: "PRINTED" | "FAILED"; errorCode?: string | null; errorMessage?: string | null };

type AckRow = { id: string; status: PrintJobStatus; claim_token: string | null; attempt_count: number; max_attempts: number; job_type: PrintJobType; created_at: Date; printer_id: string };

/**
 * Acknowledges one job of the calling agent inside a transaction that locks the row first.
 *
 * - Another tenant's job, another agent's job and an unknown id are all `NotFoundError` (SC-TEN-04, ADV-013/014).
 * - A claim token that is not the job's current one is 409 `STALE_CLAIM` — including the token of a lease that has
 *   since been re-claimed, and a `PRINTED` ack for a job that was never claimed.
 * - Repeating the ack that was already applied returns the job unchanged (200).
 * - `PRINTED` is written here and nowhere else (BR-PRINT-01, TC-PRINT-006).
 */
export async function ackJob(ctx: AgentContext, jobId: string, claimToken: string, input: AckInput, at: Date): Promise<AckResult> {
  return mapErrors("Print job", () =>
    db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AckRow[]>`
        SELECT id, status, claim_token::text AS claim_token, attempt_count, max_attempts, job_type, COALESCE(retry_window_started_at, created_at) AS created_at, printer_id::text AS printer_id
        FROM print_jobs
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${jobId}::uuid AND print_agent_id = ${ctx.agentId}::uuid
        FOR UPDATE`;
      const job = required(rows[0] ?? null, "Print job");
      if (job.claim_token === null || job.claim_token !== claimToken) {
        throw new ConflictError("This print job was re-queued for another attempt.", "STALE_CLAIM");
      }

      const attemptCount = Number(job.attempt_count);
      const maxAttempts = Number(job.max_attempts);
      const failure = () =>
        outcomeOfFailure({ jobType: job.job_type, attemptCount, maxAttempts, createdAt: new Date(job.created_at), errorCode: input.errorCode, errorMessage: input.errorMessage }, at);

      if (job.status !== PrintJobStatus.PROCESSING) {
        // Terminal or already re-queued by this same acknowledgement: identical repeats are a no-op, a different
        // outcome for a settled job is a conflict.
        const settledBy = input.result === "PRINTED" ? PrintJobStatus.PRINTED : failure().status;
        if (job.status === settledBy) {
          return { jobId, status: job.status, attemptCount, changed: false, terminalFailure: false, errorCode: null };
        }
        throw new ConflictError("This print job was already acknowledged.", "ALREADY_ACKNOWLEDGED");
      }

      if (input.result === "PRINTED") {
        await tx.printJob.updateMany({
          where: tenantScope(ctx, { id: jobId, status: PrintJobStatus.PROCESSING }),
          data: {
            status: PrintJobStatus.PRINTED,
            printedAt: at,
            leaseExpiresAt: null,
            failedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        await tx.printer.updateMany({ where: tenantScope(ctx, { id: job.printer_id }), data: { lastDeliveredAt: at } });
        return { jobId, status: PrintJobStatus.PRINTED, attemptCount, changed: true, terminalFailure: false, errorCode: null };
      }

      // Codes are normalised to the catalogue (older agents send older codes, lib/print/error-codes.ts).
      const outcome = failure();
      const cause = canonicalPrintErrorCode(input.errorCode, input.errorMessage);
      const message = input.errorMessage ?? null;
      await tx.printJob.updateMany({
        where: tenantScope(ctx, { id: jobId, status: PrintJobStatus.PROCESSING }),
        data: {
          status: outcome.status,
          leaseExpiresAt: null,
          nextAttemptAt: outcome.nextAttemptAt ?? at,
          failedAt: outcome.status === PrintJobStatus.FAILED ? at : null,
          lastErrorCode: outcome.errorCode,
          // When retries ran out, the last cause stays readable: "CONNECTION_TIMEOUT: TCP 192.168.1.103:9100: …".
          lastErrorMessage: (outcome.gaveUp ? `${cause}${message ? `: ${message}` : ""}` : message)?.slice(0, 500) ?? null,
        },
      });
      await tx.printer.updateMany({ where: tenantScope(ctx, { id: job.printer_id }), data: { lastFailedAt: at, lastErrorCode: cause } });
      return {
        jobId,
        status: outcome.status,
        attemptCount,
        changed: true,
        terminalFailure: outcome.status === PrintJobStatus.FAILED,
        errorCode: outcome.errorCode,
      };
    }),
  );
}

// ─── Manual retry and printer deactivation (SA-PRN-05, SA-PRN-03) ───

export type RetryOutcome = { before: { status: PrintJobStatus; attemptCount: number; lastErrorCode: string | null } };

/** Puts one FAILED job back in the queue, due immediately, with attempts reset (ADR-007 §4, S1-P16-T007). */
export async function retryJob(client: Tx, ctx: TenantContext, jobId: string, at: Date): Promise<RetryOutcome> {
  const existing = required(
    await client.printJob.findUnique({ where: tenantKey(ctx, jobId), select: { status: true, attemptCount: true, lastErrorCode: true, jobType: true } }),
    "Print job",
  );
  if (existing.status !== PrintJobStatus.FAILED) throw new ConflictError("Only failed print jobs can be retried.", "NOT_FAILED");

  const { count } = await client.printJob.updateMany({
    where: tenantScope(ctx, { id: jobId, status: PrintJobStatus.FAILED }),
    data: {
      status: PrintJobStatus.PENDING,
      attemptCount: 0,
      // A manual retry restarts the automatic retry window and takes the job type's current policy (2026-10-08).
      retryWindowStartedAt: at,
      maxAttempts: RETRY_POLICIES[existing.jobType].maxAttempts,
      nextAttemptAt: at,
      failedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
    },
  });
  if (count === 0) throw new ConflictError("Only failed print jobs can be retried.", "NOT_FAILED");
  return { before: { status: existing.status, attemptCount: existing.attemptCount, lastErrorCode: existing.lastErrorCode } };
}

/** Deactivating a printer fails its queued work rather than leaving it waiting for a device nobody will switch on. */
export async function failPendingJobsForPrinter(client: Tx, ctx: TenantContext, printerId: string, at: Date): Promise<number> {
  const { count } = await client.printJob.updateMany({
    where: tenantScope(ctx, { printerId, status: PrintJobStatus.PENDING }),
    data: {
      status: PrintJobStatus.FAILED,
      failedAt: at,
      lastErrorCode: "PRINTER_DISABLED",
      lastErrorMessage: "The printer was deactivated while this job was waiting.",
      leaseExpiresAt: null,
    },
  });
  return count;
}

// ─── Printers (SA-PRN-01…03) ───

export type NewPrinter = {
  name: string;
  purpose: PrinterPurpose;
  connectionType: PrinterConnection;
  connectionAddress: string;
  paperWidthMm: number;
  kitchenSectionId: string | null;
  printAgentId: string | null;
  profile?: string;
};

export async function kitchenSectionExists(client: Tx, ctx: TenantContext, kitchenSectionId: string): Promise<boolean> {
  return (await client.kitchenSection.count({ where: tenantScope(ctx, { id: kitchenSectionId, archivedAt: null }) })) > 0;
}

export async function printAgentExists(client: Tx, ctx: TenantContext, printAgentId: string): Promise<boolean> {
  return (await client.printAgent.count({ where: tenantScope(ctx, { id: printAgentId, status: { not: PrintAgentStatus.REVOKED } }) })) > 0;
}

export async function insertPrinter(client: Tx, ctx: TenantContext, printer: NewPrinter): Promise<PrinterRowDto> {
  const row = await client.printer.create({ data: { tenantId: ctx.tenantId, ...printer }, select: PRINTER_SELECT });
  return toPrinterDto(row);
}

export async function findPrinterRow(client: Tx, ctx: TenantContext, printerId: string): Promise<PrinterRowDto | null> {
  const row = await client.printer.findUnique({ where: tenantKey(ctx, printerId), select: PRINTER_SELECT });
  return row ? toPrinterDto(row) : null;
}

export async function updatePrinterRow(client: Tx, ctx: TenantContext, printerId: string, data: Partial<NewPrinter>): Promise<PrinterRowDto> {
  const { count } = await client.printer.updateMany({ where: tenantScope(ctx, { id: printerId }), data });
  if (count === 0) throw new ConflictError("The printer was changed by someone else. Reload and try again.");
  return required(await findPrinterRow(client, ctx, printerId), "Printer");
}

export async function deactivatePrinterRow(client: Tx, ctx: TenantContext, printerId: string): Promise<PrinterRowDto> {
  await client.printer.updateMany({ where: tenantScope(ctx, { id: printerId }), data: { isActive: false, health: PrinterHealth.UNKNOWN } });
  return required(await findPrinterRow(client, ctx, printerId), "Printer");
}

// ─── Agents (SA-AGT-01/02, RH-AGT-01/02/05) ───

export type NewPrintAgentPairing = { name: string; pairingCodeHash: string; pairingExpiresAt: Date; createdByUserId: string };

export async function insertPrintAgentPairing(client: Tx, ctx: TenantContext, input: NewPrintAgentPairing): Promise<PrintAgentDto> {
  const row = await client.printAgent.create({
    data: {
      tenantId: ctx.tenantId,
      name: input.name,
      status: PrintAgentStatus.PENDING_PAIRING,
      pairingCodeHash: input.pairingCodeHash,
      pairingExpiresAt: input.pairingExpiresAt,
      createdByUserId: input.createdByUserId,
    },
    select: AGENT_SELECT,
  });
  return toAgentDto(row);
}

/** Replaces the pairing code of an agent that has not paired yet, so a lost code can be reissued. */
export async function replacePairingCode(client: Tx, ctx: TenantContext, agentId: string, pairingCodeHash: string, pairingExpiresAt: Date): Promise<number> {
  const { count } = await client.printAgent.updateMany({
    where: tenantScope(ctx, { id: agentId, status: PrintAgentStatus.PENDING_PAIRING }),
    data: { pairingCodeHash, pairingExpiresAt },
  });
  return count;
}

export async function findPrintAgentRow(client: Tx, ctx: TenantContext, agentId: string): Promise<PrintAgentDto | null> {
  const row = await client.printAgent.findUnique({ where: tenantKey(ctx, agentId), select: AGENT_SELECT });
  return row ? toAgentDto(row) : null;
}

export type PairingCandidate = { id: string; tenantId: string; name: string };

/**
 * Resolves a pairing code hash to the agent waiting for it. This is the step that *establishes* the tenant, so it
 * cannot be tenant-scoped: `pairing_code_hash` is globally unique and the tenant is taken from the row it finds
 * (ADR-007 §1, SC-TEN-07). An expired or already-used code simply matches nothing.
 */
export async function findAgentByPairingCodeHash(pairingCodeHash: string, at: Date): Promise<PairingCandidate | null> {
  return mapErrors("Print agent", () =>
    // tenant-scope-exempt: pre-authentication pairing lookup by globally unique hash; the tenant comes from the row.
    db.printAgent.findFirst({
      where: { pairingCodeHash, status: PrintAgentStatus.PENDING_PAIRING, pairingExpiresAt: { gt: at } },
      select: { id: true, tenantId: true, name: true },
    }),
  );
}

export type AuthenticatedAgent = { id: string; tenantId: string; name: string; lastSeenAt: Date | null };

/**
 * Resolves a bearer-token hash to an ACTIVE agent. Like the pairing lookup, this is where the tenant comes from:
 * `token_hash` is globally unique and `tenant_id` is read from the row (ADR-007 §1, SC-TEN-07, SC-PRINT-09).
 * A revoked agent has no token hash at all, so its next call finds nothing and gets 401.
 */
export async function findAgentByTokenHash(tokenHash: string): Promise<AuthenticatedAgent | null> {
  return mapErrors("Print agent", () =>
    // tenant-scope-exempt: agent authentication by globally unique token hash; the tenant comes from the row found.
    db.printAgent.findFirst({
      where: { tokenHash, status: PrintAgentStatus.ACTIVE },
      select: { id: true, tenantId: true, name: true, lastSeenAt: true },
    }),
  );
}

/** Completes pairing: the code is consumed, the token hash and prefix are stored, the agent becomes ACTIVE. */
export async function activatePairedAgent(
  client: Tx,
  agent: { id: string; tenantId: string },
  input: { tokenHash: string; tokenPrefix: string; agentVersion: string; osInfo: string; at: Date; ip: string | null },
): Promise<number> {
  const { count } = await client.printAgent.updateMany({
    where: { tenantId: agent.tenantId, id: agent.id, status: PrintAgentStatus.PENDING_PAIRING },
    data: {
      status: PrintAgentStatus.ACTIVE,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      agentVersion: input.agentVersion,
      osInfo: input.osInfo,
      pairedAt: input.at,
      lastSeenAt: input.at,
      lastSeenIp: input.ip,
      pairingCodeHash: null,
      pairingExpiresAt: null,
    },
  });
  return count;
}

/** Liveness (ADR-007 §7). Throttled by the caller so a 3 s poll does not write on every request. */
export async function touchAgent(ctx: AgentContext, at: Date, input: { ip?: string | null; agentVersion?: string | null } = {}): Promise<void> {
  await mapErrors("Print agent", () =>
    db.printAgent.updateMany({
      where: tenantScope(ctx, { id: ctx.agentId, status: PrintAgentStatus.ACTIVE }),
      data: {
        lastSeenAt: at,
        ...(input.ip === undefined ? {} : { lastSeenIp: input.ip }),
        ...(input.agentVersion ? { agentVersion: input.agentVersion } : {}),
      },
    }),
  );
}

export async function revokeAgentRow(client: Tx, ctx: TenantContext, agentId: string, revokedByUserId: string, at: Date): Promise<number> {
  const { count } = await client.printAgent.updateMany({
    where: tenantScope(ctx, { id: agentId, status: { not: PrintAgentStatus.REVOKED } }),
    data: { status: PrintAgentStatus.REVOKED, revokedAt: at, revokedByUserId, tokenHash: null, pairingCodeHash: null, pairingExpiresAt: null },
  });
  return count;
}

/** The printer ids assigned to one agent — the only jobs it may ever claim (ADR-007 §2). */
export async function printerIdsOfAgent(tenantId: string, agentId: string): Promise<string[]> {
  const rows = await mapErrors("Printer", () =>
    db.printer.findMany({ where: { tenantId, printAgentId: agentId, isActive: true }, select: { id: true }, orderBy: { id: "asc" } }),
  );
  return rows.map((row) => row.id);
}

export type AgentPrinterConfig = {
  printerId: string;
  name: string;
  purpose: PrinterPurpose;
  connectionType: PrinterConnection;
  connectionAddress: string;
  paperWidthMm: number;
  /** Capability profile key (lib/print/profiles.ts); agents older than 2026-10-08 ignore it. */
  profile: string;
};

/** RH-AGT-05 — the printers the calling agent is responsible for, and nothing else (TC-AGENT-005, TI-041). */
export async function agentPrinterConfig(ctx: AgentContext): Promise<AgentPrinterConfig[]> {
  const rows = await mapErrors("Printer", () =>
    db.printer.findMany({
      where: tenantScope(ctx, { printAgentId: ctx.agentId, isActive: true }),
      select: { id: true, name: true, purpose: true, connectionType: true, connectionAddress: true, paperWidthMm: true, profile: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return rows.map((row) => ({
    printerId: row.id,
    name: row.name,
    purpose: row.purpose,
    connectionType: row.connectionType,
    connectionAddress: row.connectionAddress,
    paperWidthMm: row.paperWidthMm,
    profile: row.profile,
  }));
}

export type PrinterHealthReport = { printerId: string; health: PrinterHealth; detail?: string | null };

/**
 * RH-AGT-02 — a printer's health is whatever its agent last reported, never a guess. Reports for printers that are
 * not this agent's are ignored; the caller logs them as a security event (TI-041).
 */
export async function applyPrinterHealth(ctx: AgentContext, reports: readonly PrinterHealthReport[], at: Date): Promise<{ applied: string[]; ignored: string[] }> {
  const owned = new Set(ctx.printerIds);
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const report of reports) {
    if (!owned.has(report.printerId)) {
      ignored.push(report.printerId);
      continue;
    }
    const { count } = await mapErrors("Printer", () =>
      db.printer.updateMany({
        where: tenantScope(ctx, { id: report.printerId, printAgentId: ctx.agentId }),
        data: { health: report.health, healthReportedAt: at },
      }),
    );
    if (count > 0) applied.push(report.printerId);
    else ignored.push(report.printerId);
  }
  return { applied, ignored };
}

// ─── LAN printer discovery (RASOIOS-ADR-015) ───

export type PrinterDiscoveryRow = {
  id: string;
  printAgentId: string;
  status: PrinterDiscoveryStatus;
  results: unknown;
  errorCode: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

const discoverySelect = {
  id: true,
  printAgentId: true,
  status: true,
  results: true,
  errorCode: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
} as const;

/** A scan of this agent that is still REQUESTED or RUNNING and newer than `since` (so a new click reuses it). */
export async function findOpenDiscovery(client: Tx, ctx: TenantContext, printAgentId: string, since: Date): Promise<PrinterDiscoveryRow | null> {
  return client.printerDiscovery.findFirst({
    where: tenantScope(ctx, { printAgentId, status: { in: [PrinterDiscoveryStatus.REQUESTED, PrinterDiscoveryStatus.RUNNING] }, requestedAt: { gte: since } }),
    orderBy: { requestedAt: "desc" },
    select: discoverySelect,
  });
}

export async function insertDiscovery(client: Tx, ctx: TenantContext, printAgentId: string, at: Date): Promise<PrinterDiscoveryRow> {
  return client.printerDiscovery.create({
    data: { tenantId: ctx.tenantId, printAgentId, requestedByUserId: ctx.userId, requestedAt: at },
    select: discoverySelect,
  });
}

/** One scan of the caller's tenant; another tenant's id is a miss. */
export async function findDiscovery(ctx: TenantContext, discoveryId: string): Promise<PrinterDiscoveryRow | null> {
  return mapErrors("Printer discovery", () => db.printerDiscovery.findUnique({ where: tenantKey(ctx, discoveryId), select: discoverySelect }));
}

/**
 * Hands the oldest waiting scan of *this* agent to it, atomically (REQUESTED → RUNNING). Tenant and agent come from
 * the bearer token, so an agent can never pick up another agent's — or another tenant's — request.
 */
export async function takeRequestedDiscovery(ctx: AgentContext, since: Date, at: Date): Promise<string | null> {
  const rows = await mapErrors("Printer discovery", () =>
    db.$queryRaw<Array<{ id: string }>>`
      UPDATE printer_discoveries d
      SET status = 'RUNNING'::printer_discovery_status, started_at = ${at}, updated_at = now()
      WHERE d.id = (
        SELECT id FROM printer_discoveries
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND print_agent_id = ${ctx.agentId}::uuid
          AND status = 'REQUESTED'
          AND requested_at >= ${since}
        ORDER BY requested_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) AND d.tenant_id = ${ctx.tenantId}::uuid
      RETURNING d.id::text AS id`,
  );
  return rows[0]?.id ?? null;
}

/** RUNNING → COMPLETED/FAILED, only for the agent that is running it. Returns false when it was not (any more). */
export async function completeDiscovery(
  ctx: AgentContext,
  discoveryId: string,
  outcome: { status: "COMPLETED" | "FAILED"; results: Prisma.InputJsonValue; errorCode: string | null },
  at: Date,
): Promise<boolean> {
  const { count } = await mapErrors("Printer discovery", () =>
    db.printerDiscovery.updateMany({
      where: tenantScope(ctx, { id: discoveryId, printAgentId: ctx.agentId, status: PrinterDiscoveryStatus.RUNNING }),
      data: { status: outcome.status, results: outcome.results, errorCode: outcome.errorCode, completedAt: at },
    }),
  );
  return count === 1;
}

// ─── Printer connection checks (printing audit 2026-10-08 P0) ───

export type PrinterCheckRow = {
  id: string;
  printerId: string;
  printAgentId: string;
  status: PrinterCheckStatus;
  ok: boolean | null;
  errorCode: string | null;
  detail: string | null;
  elapsedMs: number | null;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

const checkSelect = {
  id: true,
  printerId: true,
  printAgentId: true,
  status: true,
  ok: true,
  errorCode: true,
  detail: true,
  elapsedMs: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
} as const;

/** A check of this printer still REQUESTED or RUNNING and newer than `since` — a second click reuses it. */
export async function findOpenCheck(client: Tx, ctx: TenantContext, printerId: string, since: Date): Promise<PrinterCheckRow | null> {
  return client.printerCheck.findFirst({
    where: tenantScope(ctx, { printerId, status: { in: [PrinterCheckStatus.REQUESTED, PrinterCheckStatus.RUNNING] }, requestedAt: { gte: since } }),
    orderBy: { requestedAt: "desc" },
    select: checkSelect,
  });
}

export async function insertCheck(client: Tx, ctx: TenantContext, input: { printerId: string; printAgentId: string; requestedByUserId: string }, at: Date): Promise<PrinterCheckRow> {
  return client.printerCheck.create({
    data: { tenantId: ctx.tenantId, printerId: input.printerId, printAgentId: input.printAgentId, requestedByUserId: input.requestedByUserId, requestedAt: at },
    select: checkSelect,
  });
}

/** One check of the caller's tenant; another tenant's id is a miss. */
export async function findCheck(ctx: TenantContext, checkId: string): Promise<PrinterCheckRow | null> {
  return mapErrors("Printer check", () => db.printerCheck.findUnique({ where: tenantKey(ctx, checkId), select: checkSelect }));
}

/** REQUESTED/RUNNING → EXPIRED once the agent has had its chance. Returns the row as it is afterwards. */
export async function expireCheck(ctx: TenantContext, checkId: string, at: Date): Promise<PrinterCheckRow | null> {
  await mapErrors("Printer check", () =>
    db.printerCheck.updateMany({
      where: tenantScope(ctx, { id: checkId, status: { in: [PrinterCheckStatus.REQUESTED, PrinterCheckStatus.RUNNING] } }),
      data: { status: PrinterCheckStatus.EXPIRED, completedAt: at },
    }),
  );
  return findCheck(ctx, checkId);
}

/**
 * Hands this agent its waiting checks, atomically (REQUESTED → RUNNING), only for printers it still owns. Tenant and
 * agent come from the bearer token, so an agent never receives another agent's — or tenant's — request.
 */
export async function takeRequestedChecks(ctx: AgentContext, since: Date, at: Date): Promise<Array<{ checkId: string; printerId: string }>> {
  if (ctx.printerIds.length === 0) return [];
  const rows = await mapErrors("Printer check", () =>
    db.$queryRaw<Array<{ id: string; printer_id: string }>>`
      UPDATE printer_checks c
      SET status = 'RUNNING'::printer_check_status, started_at = ${at}, updated_at = now()
      WHERE c.id IN (
        SELECT id FROM printer_checks
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND print_agent_id = ${ctx.agentId}::uuid
          AND printer_id = ANY(${[...ctx.printerIds]}::uuid[])
          AND status = 'REQUESTED'
          AND requested_at >= ${since}
        ORDER BY requested_at
        LIMIT 5
        FOR UPDATE SKIP LOCKED
      ) AND c.tenant_id = ${ctx.tenantId}::uuid
      RETURNING c.id::text AS id, c.printer_id::text AS printer_id`,
  );
  return rows.map((row) => ({ checkId: row.id, printerId: row.printer_id }));
}

/** RUNNING → COMPLETED with the agent's result, only for the agent running it. False when it was not (any more). */
export async function completeCheck(
  ctx: AgentContext,
  checkId: string,
  result: { ok: boolean; errorCode: string | null; detail: string | null; elapsedMs: number },
  at: Date,
): Promise<PrinterCheckRow | null> {
  const { count } = await mapErrors("Printer check", () =>
    db.printerCheck.updateMany({
      where: tenantScope(ctx, { id: checkId, printAgentId: ctx.agentId, status: PrinterCheckStatus.RUNNING }),
      data: { status: PrinterCheckStatus.COMPLETED, ok: result.ok, errorCode: result.errorCode, detail: result.detail, elapsedMs: result.elapsedMs, completedAt: at },
    }),
  );
  if (count !== 1) return null;
  return mapErrors("Printer check", () => db.printerCheck.findUnique({ where: tenantKey(ctx, checkId), select: checkSelect }));
}

// ─── Cancel, archive, stale pairings (printing audit 2026-10-08) ───

const CANCELLABLE = [PrintJobStatus.PENDING, PrintJobStatus.FAILED];

/**
 * QUEUED / RETRYING (PENDING) or FAILED → CANCELLED. A job being sent (PROCESSING) or already delivered is never
 * cancelled: the agent may be writing it to the printer at this moment.
 */
export async function cancelJob(client: Tx, ctx: TenantContext, jobId: string, input: { userId: string; reason: string | null }, at: Date): Promise<{ before: { status: PrintJobStatus; attemptCount: number } }> {
  const existing = required(await client.printJob.findUnique({ where: tenantKey(ctx, jobId), select: { status: true, attemptCount: true } }), "Print job");
  const refuse = () => new ConflictError("Only queued, retrying or failed print jobs can be cancelled. A job being sent to the printer cannot be stopped.", "NOT_CANCELLABLE");
  if (!CANCELLABLE.some((status) => status === existing.status)) throw refuse();
  const { count } = await client.printJob.updateMany({
    where: tenantScope(ctx, { id: jobId, status: { in: CANCELLABLE } }),
    data: { status: PrintJobStatus.CANCELLED, cancelledAt: at, cancelledByUserId: input.userId, cancelReason: input.reason, claimToken: null, leaseExpiresAt: null },
  });
  if (count === 0) throw refuse();
  return { before: existing };
}

/** Archive hides a deactivated printer from the list (the row and its jobs stay); restore brings it back, still inactive. */
export async function setPrinterArchived(client: Tx, ctx: TenantContext, printerId: string, archived: boolean, at: Date): Promise<number> {
  const { count } = await client.printer.updateMany({
    where: tenantScope(ctx, archived ? { id: printerId, isActive: false, archivedAt: null } : { id: printerId, archivedAt: { not: null } }),
    data: { archivedAt: archived ? at : null },
  });
  return count;
}

/**
 * Pairing attempts whose code has expired are closed (status REVOKED, code hash cleared) — never deleted, so the history
 * of who started a pairing stays. Returns the ids closed.
 */
export async function closeExpiredPairings(client: Tx, ctx: TenantContext, userId: string, at: Date): Promise<string[]> {
  const stale = await client.printAgent.findMany({
    where: tenantScope(ctx, { status: PrintAgentStatus.PENDING_PAIRING, OR: [{ pairingExpiresAt: null }, { pairingExpiresAt: { lt: at } }] }),
    select: { id: true },
  });
  if (stale.length === 0) return [];
  const ids = stale.map((row) => row.id);
  await client.printAgent.updateMany({
    where: tenantScope(ctx, { id: { in: ids }, status: PrintAgentStatus.PENDING_PAIRING }),
    data: { status: PrintAgentStatus.REVOKED, revokedAt: at, revokedByUserId: userId, pairingCodeHash: null, pairingExpiresAt: null },
  });
  return ids;
}
