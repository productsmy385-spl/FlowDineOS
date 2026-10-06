import "server-only";
import { randomUUID } from "node:crypto";
import { PrintJobStatus, PrintJobType, PrinterHealth, type PrinterConnection, type PrinterPurpose, type Prisma } from "@prisma/client";
import { audit } from "@/lib/audit/write";
import { issueAgentToken, sha256Hex } from "@/lib/auth/agent";
import type { AgentContext, TenantContext } from "@/lib/auth/context-types";
import { hasPermission } from "@/lib/auth/permissions";
import { findKitchenTicket, listKitchenSections } from "@/lib/data/kot";
import {
  ackJob,
  activatePairedAgent,
  agentPrinterConfig,
  applyPrinterHealth,
  claimJobs,
  countKotReprints,
  countReceiptJobs,
  createPrintJob,
  deactivatePrinterRow,
  failPendingJobsForPrinter,
  findAgentByPairingCodeHash,
  findPrintAgentRow,
  findPrinterRow,
  findPrinterTarget,
  getPrintJob,
  insertPrinter,
  insertPrintAgentPairing,
  kitchenSectionExists,
  kotDispatchOfOrder,
  completeDiscovery,
  findDiscovery,
  findOpenDiscovery,
  insertDiscovery,
  takeRequestedDiscovery,
  type PrinterDiscoveryRow,
  listActivePrinters as listActivePrintersData,
  listPrintAgents,
  listPrinters as listPrintersData,
  listPrintJobs as listPrintJobsData,
  printingProfile,
  printAgentExists,
  resolveKotPrinter,
  resolveReceiptPrinter,
  retryJob,
  revokeAgentRow,
  updatePrinterRow,
  type AgentPrinterConfig,
  type ClaimedJob,
  type PrintAgentDto,
  type PrinterDto,
  type PrinterTarget,
  type PrintJobDto,
  type PrintJobFilters,
} from "@/lib/data/printing";
import { getReceipt } from "@/lib/data/receipts";
import { required } from "@/lib/data/scope";
import { withTx, type Tx } from "@/lib/data/tx";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { renderKotDocument } from "@/lib/print/render-kot";
import { renderReceiptDocument } from "@/lib/print/render-receipt";
import { renderTestDocument } from "@/lib/print/render-test";
import { consume } from "@/lib/security/rate-limit";
import { now } from "@/lib/time/clock";
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, connectionAddressIssue, discoveredPrinterSchema, type AgentDiscoveryReport, type DiscoveredPrinter } from "@/lib/validation/printing";

/**
 * Printing services (S1-P16-T003/T004/T007, ADR-004, ADR-007). Rebuilt on `lib/data/printing.ts`: this module no
 * longer touches Prisma (ADR-008, SC-TEN-03).
 *
 * What lives here is the business layer of printing: which printer a job goes to (architecture.md §6.2), what the
 * ticket says (`lib/print/*`), when a job may be created twice (never — dedupe keys, SC-PRINT-05) and what a human
 * may do to the queue. The agent-facing half — claim, acknowledge, heartbeat, config — is a thin wrapper over the
 * atomic queue operations, with the audit rows the agent's actions deserve.
 */

export type { PrintAgentDto, PrinterDto, PrintJobDto, PrintJobFilters };

/** ADR-007 §7 — the intervals the agent is told to use, and when the console calls an agent offline. */
export const POLL_INTERVAL_MS = 3_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const AGENT_OFFLINE_AFTER_MS = 90_000;

/** Pairing codes live 10 minutes and are single-use (ADR-007 §1, SC-PRINT-02). */
export const PAIRING_TTL_MS = 10 * 60_000;

const TEST_PRINT_RATE_LIMIT = { limit: 6, windowSec: 60, failOpen: false } as const;
const REPRINT_RATE_LIMIT = { limit: 10, windowSec: 60, failOpen: false } as const;
const PAIRING_CREATE_RATE_LIMIT = { limit: 10, windowSec: 3600, failOpen: false } as const;

/** 429 as an application error, so Server Actions return it in the standard envelope. */
class TooManyRequestsError extends AppError {
  constructor(message: string) {
    super(message, 429, "RATE_LIMITED");
  }
}

async function enforceRateLimit(scope: string, identifier: string, policy: { limit: number; windowSec: number; failOpen: boolean }, message: string): Promise<void> {
  const result = await consume(scope, identifier, policy);
  if (!result.allowed) throw new TooManyRequestsError(message);
}

// ─── Console reads (LD-PRN-01, RH-PRN-01) ───

export type PrintingConsoleAgent = PrintAgentDto & { online: boolean };

export type PrintingConsole = {
  agents: PrintingConsoleAgent[];
  printers: PrinterDto[];
  jobs: PrintJobDto[];
  serverTime: string;
};

/**
 * LD-PRN-01's projection (api.md §13, SC-API-05): the queue view carries printer health, station and agent, but not a
 * device address, and it identifies an agent by name, not by a fragment of its token. Both extras are restored only
 * for the roles that manage those objects (`printer:manage`, `print_agent:manage` — security.md §3.3 rows 44–45).
 */
function projectPrinters(ctx: TenantContext, printers: readonly PrinterDto[]): PrinterDto[] {
  if (hasPermission(ctx, "printer:manage")) return [...printers];
  return printers.map((printer) => ({ ...printer, connectionAddress: null }));
}

function projectAgents(ctx: TenantContext, agents: readonly PrintAgentDto[]): PrintAgentDto[] {
  if (hasPermission(ctx, "print_agent:manage")) return [...agents];
  return agents.map((agent) => ({ ...agent, tokenPrefix: null }));
}

/** An agent is online when it called within the heartbeat grace window — never a stored flag (ADR-007 §7, BA-30). */
export function isAgentOnline(agent: Pick<PrintAgentDto, "status" | "lastSeenAt">, at: Date = now()): boolean {
  if (agent.status !== "ACTIVE" || !agent.lastSeenAt) return false;
  return at.getTime() - Date.parse(agent.lastSeenAt) <= AGENT_OFFLINE_AFTER_MS;
}

export function withOnlineFlag(agents: readonly PrintAgentDto[], at: Date = now()): PrintingConsoleAgent[] {
  return agents.map((agent) => ({ ...agent, online: isAgentOnline(agent, at) }));
}

/** LD-PRN-01 — the whole console in one read: agents, printers and the newest 50 jobs of the caller's tenant. */
export async function getPrintingConsole(ctx: TenantContext, filters: PrintJobFilters = {}): Promise<PrintingConsole> {
  const at = now();
  const [agents, printers, jobs] = await Promise.all([listPrintAgents(ctx), listPrintersData(ctx), listPrintJobsData(ctx, filters)]);
  return {
    agents: withOnlineFlag(projectAgents(ctx, agents), at),
    printers: projectPrinters(ctx, printers),
    jobs,
    serverTime: at.toISOString(),
  };
}

/** Every printer of the caller's tenant, including deactivated ones — the full row, for `printer:manage` callers. */
export async function listPrinters(ctx: TenantContext): Promise<PrinterDto[]> {
  return projectPrinters(ctx, await listPrintersData(ctx));
}

/** Agents of the caller's tenant with a derived `online` flag (never a stored one). */
export async function listAgents(ctx: TenantContext): Promise<PrintingConsoleAgent[]> {
  return withOnlineFlag(projectAgents(ctx, await listPrintAgents(ctx)));
}

/** The queue of the caller's tenant, newest first. */
export async function listPrintJobs(ctx: TenantContext, filters: PrintJobFilters = {}, limit = 50): Promise<PrintJobDto[]> {
  return listPrintJobsData(ctx, filters, limit);
}

/** Active printers of the caller's tenant (target lists and the header indicator). */
export async function listActivePrinters(ctx: TenantContext): Promise<PrinterDto[]> {
  return projectPrinters(ctx, await listActivePrintersData(ctx));
}

/** Kitchen stations a printer can be bound to (the printer dialog's station list). */
export async function listPrintingSections(ctx: TenantContext): Promise<Array<{ id: string; name: string }>> {
  const sections = await listKitchenSections(ctx);
  return sections.map((section) => ({ id: section.id, name: section.name }));
}

/** RH-PRN-01 — jobs changed at or after `since`, plus the new cursor. */
export async function pollPrintJobs(ctx: TenantContext, input: { since?: Date; status?: PrintJobStatus; jobType?: PrintJobType } = {}): Promise<{ jobs: PrintJobDto[]; serverTime: string }> {
  const at = now();
  const jobs = await listPrintJobsData(ctx, { status: input.status, jobType: input.jobType, since: input.since }, 100);
  return { jobs, serverTime: at.toISOString() };
}

// ─── KOT producers (S1-P16-T003, REQ-PRINT-001, REQ-KOT-007) ───

async function buildKotDocument(tx: Tx, ctx: TenantContext, kotId: string, printer: PrinterTarget, restaurantName: string, isReprint: boolean) {
  const ticket = required(await findKitchenTicket(tx, ctx, kotId), "KOT");
  return {
    ticket,
    document: renderKotDocument({
      widthMm: printer.paperWidthMm,
      restaurantName,
      kotNumber: ticket.kotNumber,
      sectionName: ticket.kitchenSection?.name ?? null,
      roundNumber: ticket.roundNumber,
      orderNumber: ticket.orderNumber,
      orderType: ticket.orderTypeSnapshot,
      tableLabel: ticket.tableLabelSnapshot,
      priority: ticket.priority,
      queuedAt: new Date(ticket.queuedAt),
      timeZone: ctx.restaurant.timezone,
      notes: ticket.notesSnapshot,
      items: ticket.items.map((item) => ({
        quantity: item.quantity,
        label: item.itemLabelSnapshot,
        addons: item.addonsSnapshot,
        instructions: item.instructionsSnapshot,
      })),
      isReprint,
    }),
  };
}

/**
 * S1-P16-T003 — queues one KOT job per freshly generated ticket, **inside the order's acceptance transaction**, so a
 * ticket and its print job commit together or not at all. Skipped entirely when the restaurant has auto-print off;
 * skipped per ticket when no KOT printer serves that section (architecture.md §6.2) — the ticket then reads
 * `printStatus: NONE` on the board rather than pretending a printer exists. Dedupe key `KOT:{kotId}:v1` makes a
 * retried acceptance a no-op (SC-PRINT-05).
 */
export async function enqueueKotPrintJobs(tx: Tx, ctx: TenantContext, kotIds: readonly string[]): Promise<string[]> {
  if (kotIds.length === 0) return [];
  const profile = await printingProfile(tx, ctx);
  if (!profile.autoPrintKot) return [];

  const queued: string[] = [];
  for (const kotId of kotIds) {
    const ticket = required(await findKitchenTicket(tx, ctx, kotId), "KOT");
    const printer = await resolveKotPrinter(tx, ctx, ticket.kitchenSection?.id ?? null);
    if (!printer) continue;

    const { document } = await buildKotDocument(tx, ctx, kotId, printer, profile.name, false);
    const { id, created } = await createPrintJob(tx, ctx, {
      printerId: printer.id,
      jobType: PrintJobType.KOT,
      dedupeKey: `KOT:${kotId}:v1`,
      payload: document,
      kotTicketId: kotId,
      orderId: null,
      requestedByUserId: ctx.userId,
    });
    if (created) queued.push(id);
  }
  if (queued.length > 0) {
    logger.info("print_job.kot_queued", { requestId: ctx.requestId, tenantId: ctx.tenantId, count: queued.length });
  }
  return queued;
}

/**
 * SA-KOT-02 — an explicit reprint: a new job with `is_reprint = true` and dedupe key `KOT:{id}:reprint:{n}`. A
 * reprint never changes what the board says about the ticket, because `printStatusFor` reads the newest *non*-reprint
 * job (lib/data/kot.ts). Rate limited to 10/min per user.
 */
export async function reprintKot(ctx: TenantContext, kotId: string): Promise<PrintJobDto> {
  await enforceRateLimit("kot.reprint", `${ctx.tenantId}:${ctx.userId}`, REPRINT_RATE_LIMIT, "Too many reprints. Wait a moment and try again.");

  const job = await withTx(ctx, async (tx) => {
    const ticket = required(await findKitchenTicket(tx, ctx, kotId), "KOT");
    const printer = await resolveKotPrinter(tx, ctx, ticket.kitchenSection?.id ?? null);
    if (!printer) throw new ValidationError("No kitchen printer is set up for this station.", undefined, "NO_PRINTER_CONFIGURED");

    const profile = await printingProfile(tx, ctx);
    const { document } = await buildKotDocument(tx, ctx, kotId, printer, profile.name, true);
    const sequence = (await countKotReprints(tx, ctx, kotId)) + 1;
    const { id } = await createPrintJob(tx, ctx, {
      printerId: printer.id,
      jobType: PrintJobType.KOT,
      dedupeKey: `KOT:${kotId}:reprint:${sequence}`,
      payload: document,
      kotTicketId: kotId,
      isReprint: true,
      requestedByUserId: ctx.userId,
    });

    await audit(tx, ctx, {
      action: "kot.reprint_requested",
      resourceType: "kot_ticket",
      resourceId: kotId,
      after: { printJobId: id, printerId: printer.id, kotNumber: ticket.kotNumber, sequence },
    });
    return getPrintJob(tx, ctx, id);
  });

  logger.info("kot.reprint_requested", { requestId: ctx.requestId, tenantId: ctx.tenantId, kotId, printJobId: job.id });
  return job;
}

// ─── Receipt and test producers (SA-PRN-06, SA-PRN-04) ───

/** SA-PRN-06 — queues the thermal receipt of an order on a RECEIPT-capable printer. */
export async function printReceipt(ctx: TenantContext, orderId: string): Promise<PrintJobDto> {
  const job = await queueReceipt(ctx, orderId, "manual");
  if (!job) throw new ValidationError("No receipt printer is set up.", undefined, "NO_PRINTER_CONFIGURED");
  return job;
}

/** What happened to the receipt a payment asked for. "QUEUED" means handed to the print agent, not printed. */
export type ReceiptQueueOutcome =
  | { status: "QUEUED"; printJobId: string }
  | { status: "NO_PRINTER" }
  | { status: "FAILED" }
  | { status: "NOT_REQUESTED" };

/**
 * The receipt a completed payment prints (owner brief 2026-10-06 §15–17: customer pays, cashier records it, the
 * receipt prints on the restaurant's own printer).
 *
 * Keyed to the payment, `RECEIPT:PAYMENT:<transactionId>`, so the same payment can never queue a second receipt —
 * `createPrintJob` inserts with ON CONFLICT DO NOTHING on (tenant_id, dedupe_key). Never throws: the payment has
 * already committed and is the thing that matters, so a missing printer or a queue failure is reported back to the
 * cashier, not turned into a failed payment. "QUEUED" is all this can honestly say — the agent's confirmation is what
 * marks the job PRINTED.
 */
export async function queueReceiptForPayment(ctx: TenantContext, orderId: string, transactionId: string): Promise<ReceiptQueueOutcome> {
  try {
    const job = await queueReceipt(ctx, orderId, `RECEIPT:PAYMENT:${transactionId}`);
    return job ? { status: "QUEUED", printJobId: job.id } : { status: "NO_PRINTER" };
  } catch (error) {
    logger.error("receipt.auto_print_failed", { requestId: ctx.requestId, tenantId: ctx.tenantId, orderId, transactionId, error: String(error) });
    return { status: "FAILED" };
  }
}

/**
 * Renders and queues one receipt. `dedupe` is either "manual" — a cashier asking again gets a new copy each time
 * (`RECEIPT:<order>:v<n>`) — or a fixed key, which makes the call idempotent. Returns null when the restaurant has no
 * receipt printer.
 */
async function queueReceipt(ctx: TenantContext, orderId: string, dedupe: "manual" | string): Promise<PrintJobDto | null> {
  const receipt = required(await getReceipt(ctx, orderId), "Order");

  const job = await withTx(ctx, async (tx) => {
    const printer = await resolveReceiptPrinter(tx, ctx);
    if (!printer) return null;
    const profile = await printingProfile(tx, ctx);

    const document = renderReceiptDocument({
      widthMm: printer.paperWidthMm,
      restaurantName: receipt.restaurant.name,
      addressLines: profile.addressLines,
      phone: receipt.restaurant.contactPhone,
      gstin: profile.gstin,
      orderNumber: receipt.orderNumber,
      orderType: receipt.orderType as Parameters<typeof renderReceiptDocument>[0]["orderType"],
      tableLabel: receipt.tableLabel,
      createdAt: new Date(receipt.createdAt),
      timeZone: receipt.timezone,
      currencyCode: receipt.currencyCode,
      customerName: receipt.customerName,
      items: receipt.items.map((item) => ({
        quantity: item.quantity,
        label: item.name,
        taxRate: item.taxRate,
        lineSubtotal: item.lineSubtotal,
        lineTax: item.lineTax,
        lineTotal: item.lineTotal,
      })),
      totals: receipt.totals,
      ledger: receipt.ledger.map((entry) => ({ type: entry.type, method: entry.method, amount: entry.amount, amountTendered: entry.amountTendered, changeDue: entry.changeDue })),
      footer: profile.receiptFooter,
    });

    const dedupeKey = dedupe === "manual" ? `RECEIPT:${orderId}:v${(await countReceiptJobs(tx, ctx, orderId)) + 1}` : dedupe;
    const { id, created } = await createPrintJob(tx, ctx, {
      printerId: printer.id,
      jobType: PrintJobType.RECEIPT,
      dedupeKey,
      payload: document,
      orderId,
      requestedByUserId: ctx.userId,
    });
    // An already-queued receipt for the same key is returned as it is, and audited once — when it was created.
    if (created) {
      await audit(tx, ctx, {
        action: "print_job.created",
        resourceType: "print_job",
        resourceId: id,
        after: { jobType: PrintJobType.RECEIPT, printerId: printer.id, orderId, orderNumber: receipt.orderNumber, trigger: dedupe === "manual" ? "manual" : "payment" },
      });
    }
    return getPrintJob(tx, ctx, id);
  });

  if (job) logger.info("print_job.created", { requestId: ctx.requestId, tenantId: ctx.tenantId, printJobId: job.id, jobType: job.jobType });
  return job;
}

/** SA-PRN-04 — a server-built test page for one of the caller's active printers. Rate limited to 6/min per printer. */
export async function createTestPrintJob(ctx: TenantContext, printerId: string): Promise<PrintJobDto> {
  // Counted before the printer is looked up, so a caller cannot use the endpoint as a printer-existence oracle by
  // spending someone else's budget — the bucket is this tenant's and this id's.
  await enforceRateLimit("printer.test", `${ctx.tenantId}:${printerId}`, TEST_PRINT_RATE_LIMIT, "Too many test prints for this printer. Wait a moment and try again.");

  const job = await withTx(ctx, async (tx) => {
    const printer = await findPrinterTarget(tx, ctx, printerId);
    if (!printer) throw new NotFoundError("Printer not found");

    const profile = await printingProfile(tx, ctx);
    const requestedAt = now();
    const document = renderTestDocument({
      widthMm: printer.paperWidthMm,
      restaurantName: profile.name,
      printerName: printer.name,
      requestedAt,
      timeZone: ctx.restaurant.timezone,
    });

    const { id } = await createPrintJob(tx, ctx, {
      printerId: printer.id,
      jobType: PrintJobType.TEST,
      dedupeKey: `TEST:${randomUUID()}`,
      payload: document,
      requestedByUserId: ctx.userId,
    });
    await audit(tx, ctx, {
      action: "print_job.created",
      resourceType: "print_job",
      resourceId: id,
      after: { jobType: PrintJobType.TEST, status: PrintJobStatus.PENDING, printerId: printer.id },
    });
    return getPrintJob(tx, ctx, id);
  });

  logger.info("print_job.created", { requestId: ctx.requestId, tenantId: ctx.tenantId, printJobId: job.id, jobType: job.jobType });
  return job;
}

// ─── Manual retry (SA-PRN-05, S1-P16-T007) ───

/**
 * SA-PRN-05 — puts one FAILED job of the caller's tenant back in the queue, due now, attempts reset. Another tenant's
 * job and an unknown id are the same 404; a job that is not FAILED is 409 `NOT_FAILED`.
 */
export async function retryPrintJob(ctx: TenantContext, jobId: string): Promise<PrintJobDto> {
  const job = await withTx(ctx, async (tx) => {
    const { before } = await retryJob(tx, ctx, jobId, now());
    const updated = await getPrintJob(tx, ctx, jobId);
    await audit(tx, ctx, {
      action: "print_job.retried",
      resourceType: "print_job",
      resourceId: jobId,
      before: { status: before.status, attemptCount: before.attemptCount, lastErrorCode: before.lastErrorCode },
      after: { status: updated.status, attemptCount: updated.attemptCount },
    });
    return updated;
  });

  logger.info("print_job.retried", { requestId: ctx.requestId, tenantId: ctx.tenantId, printJobId: job.id });
  return job;
}

// ─── Printers (SA-PRN-01…03) ───

export type CreatePrinterData = {
  name: string;
  purpose: PrinterPurpose;
  connectionType: PrinterConnection;
  connectionAddress: string;
  paperWidthMm: number;
  kitchenSectionId: string | null;
  printAgentId: string | null;
};

async function assertRelationsOwned(
  tx: Tx,
  ctx: TenantContext,
  data: { kitchenSectionId?: string | null; printAgentId?: string | null },
): Promise<void> {
  // A section or agent of another tenant is indistinguishable from one that does not exist (SC-TEN-04, TI-044).
  if (data.kitchenSectionId && !(await kitchenSectionExists(tx, ctx, data.kitchenSectionId))) throw new NotFoundError("Kitchen section not found");
  if (data.printAgentId && !(await printAgentExists(tx, ctx, data.printAgentId))) throw new NotFoundError("Print agent not found");
}

export async function createPrinter(ctx: TenantContext, data: CreatePrinterData): Promise<PrinterDto> {
  const printer = await withTx(ctx, async (tx) => {
    await assertRelationsOwned(tx, ctx, data);
    const created = await insertPrinter(tx, ctx, data);
    await audit(tx, ctx, {
      action: "printer.created",
      resourceType: "printer",
      resourceId: created.id,
      after: { name: created.name, purpose: created.purpose, connectionType: created.connectionType, paperWidthMm: created.paperWidthMm, kitchenSectionId: created.kitchenSectionId, printAgentId: created.printAgentId },
    });
    return created;
  });
  logger.info("printer.created", { requestId: ctx.requestId, tenantId: ctx.tenantId, printerId: printer.id });
  return printer;
}

export type UpdatePrinterData = Partial<CreatePrinterData> & { printerId: string };

export async function updatePrinter(ctx: TenantContext, input: UpdatePrinterData): Promise<PrinterDto> {
  const { printerId, ...changes } = input;
  return withTx(ctx, async (tx) => {
    const existing = required(await findPrinterRow(tx, ctx, printerId), "Printer");
    await assertRelationsOwned(tx, ctx, changes);

    // Re-validate the address against the *effective* connection type when only one of the pair changed.
    const connectionType = changes.connectionType ?? existing.connectionType;
    const connectionAddress = changes.connectionAddress ?? existing.connectionAddress;
    const issue = connectionAddressIssue(connectionType, connectionAddress);
    if (issue) throw new ValidationError("Check the highlighted fields.", { connectionAddress: [issue] });

    const updated = await updatePrinterRow(tx, ctx, printerId, { ...changes, connectionType, connectionAddress });
    await audit(tx, ctx, {
      action: "printer.updated",
      resourceType: "printer",
      resourceId: printerId,
      before: { name: existing.name, purpose: existing.purpose, connectionType: existing.connectionType, paperWidthMm: existing.paperWidthMm, kitchenSectionId: existing.kitchenSectionId, printAgentId: existing.printAgentId },
      after: { name: updated.name, purpose: updated.purpose, connectionType: updated.connectionType, paperWidthMm: updated.paperWidthMm, kitchenSectionId: updated.kitchenSectionId, printAgentId: updated.printAgentId },
    });
    return updated;
  });
}

/** SA-PRN-03 — deactivation also fails the printer's waiting jobs with `PRINTER_DEACTIVATED` (architecture.md §6.3). */
export async function deactivatePrinter(ctx: TenantContext, printerId: string): Promise<{ printer: PrinterDto; failedJobs: number }> {
  const result = await withTx(ctx, async (tx) => {
    const existing = required(await findPrinterRow(tx, ctx, printerId), "Printer");
    if (!existing.isActive) throw new ConflictError("This printer is already deactivated.", "ALREADY_DEACTIVATED");

    const failedJobs = await failPendingJobsForPrinter(tx, ctx, printerId, now());
    const printer = await deactivatePrinterRow(tx, ctx, printerId);
    await audit(tx, ctx, {
      action: "printer.deactivated",
      resourceType: "printer",
      resourceId: printerId,
      before: { isActive: true, health: existing.health },
      after: { isActive: false, failedJobs },
    });
    return { printer, failedJobs };
  });

  logger.info("printer.deactivated", { requestId: ctx.requestId, tenantId: ctx.tenantId, printerId, failedJobs: result.failedJobs });
  return result;
}

// ─── Agents (SA-AGT-01, SA-AGT-02) ───

/** 8 characters of CSPRNG output over a 32-symbol alphabet — 40 bits, and single-use for 10 minutes (SC-PRINT-02). */
export function generatePairingCode(): string {
  const bytes = randomUUID().replace(/-/g, "");
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % PAIRING_ALPHABET.length];
  }
  return code;
}

export type PairingIssued = { agentId: string; name: string; pairingCode: string; expiresAt: string };

/**
 * SA-AGT-01 — registers an agent and returns its pairing code **once**. Only the SHA-256 hash is stored, and the code
 * never reaches a log or an audit row (SC-PRINT-02, TC-AGENT-002 acceptance). Rate limited to 10/hour per tenant.
 */
export async function createPrintAgentPairing(ctx: TenantContext, name: string): Promise<PairingIssued> {
  await enforceRateLimit("agent.pairing.create", ctx.tenantId, PAIRING_CREATE_RATE_LIMIT, "Too many pairing codes were created for this restaurant. Try again later.");

  const pairingCode = generatePairingCode();
  const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS);

  const agent = await withTx(ctx, async (tx) => {
    const created = await insertPrintAgentPairing(tx, ctx, {
      name,
      pairingCodeHash: sha256Hex(pairingCode),
      pairingExpiresAt: expiresAt,
      createdByUserId: ctx.userId,
    });
    await audit(tx, ctx, {
      action: "print_agent.created",
      resourceType: "print_agent",
      resourceId: created.id,
      after: { name: created.name, status: created.status, pairingExpiresAt: expiresAt.toISOString() },
    });
    return created;
  });

  logger.info("print_agent.created", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: agent.id });
  return { agentId: agent.id, name: agent.name, pairingCode, expiresAt: expiresAt.toISOString() };
}

/** SA-AGT-02 — revokes an agent. Its token hash is cleared, so the next agent call is 401 (SC-PRINT-09). */
export async function revokePrintAgent(ctx: TenantContext, agentId: string): Promise<PrintAgentDto> {
  const agent = await withTx(ctx, async (tx) => {
    const existing = required(await findPrintAgentRow(tx, ctx, agentId), "Print agent");
    if (existing.status === "REVOKED") throw new ConflictError("This agent is already revoked.", "ALREADY_REVOKED");

    await revokeAgentRow(tx, ctx, agentId, ctx.userId, now());
    const updated = required(await findPrintAgentRow(tx, ctx, agentId), "Print agent");
    await audit(tx, ctx, {
      action: "print_agent.revoked",
      resourceType: "print_agent",
      resourceId: agentId,
      before: { status: existing.status, tokenPrefix: existing.tokenPrefix },
      after: { status: updated.status },
    });
    return updated;
  });

  logger.info("print_agent.revoked", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: agentId });
  return agent;
}

// ─── Agent API (RH-AGT-01…05) ───

/** 401 for every pairing failure: a wrong code, an expired code and an already-used code are indistinguishable. */
export class InvalidPairingCodeError extends AppError {
  constructor() {
    super("Invalid or expired pairing code.", 401, "INVALID_PAIRING_CODE");
  }
}

export type PairedAgent = { agentId: string; token: string; printers: AgentPrinterConfig[]; pollIntervalMs: number; heartbeatIntervalMs: number };

/**
 * RH-AGT-01 — exchanges a pairing code for a bearer token, shown once. The tenant comes from the PRINT_AGENT row the
 * code hash resolved to, never from the request (ADR-007 §1). The audit row is written as the agent itself
 * (`actorType = PRINT_AGENT`) and contains the token prefix only.
 */
export async function pairPrintAgent(
  input: { pairingCode: string; agentVersion: string; osInfo: string },
  meta: { requestId: string; ip: string | null },
): Promise<PairedAgent> {
  const at = now();
  const candidate = await findAgentByPairingCodeHash(sha256Hex(input.pairingCode), at);
  if (!candidate) {
    logger.warn("security.agent_pairing_rejected", { requestId: meta.requestId });
    throw new InvalidPairingCodeError();
  }

  const issued = issueAgentToken();
  const ctx: AgentContext = { kind: "agent", requestId: meta.requestId, agentId: candidate.id, tenantId: candidate.tenantId, printerIds: [] };

  await withTx(ctx, async (tx) => {
    const claimed = await activatePairedAgent(tx, candidate, {
      tokenHash: issued.tokenHash,
      tokenPrefix: issued.tokenPrefix,
      agentVersion: input.agentVersion,
      osInfo: input.osInfo,
      at,
      ip: meta.ip,
    });
    // Lost the race for a single-use code: treat it exactly like a wrong one.
    if (claimed === 0) throw new InvalidPairingCodeError();
    await audit(tx, ctx, {
      action: "print_agent.paired",
      resourceType: "print_agent",
      resourceId: candidate.id,
      after: { name: candidate.name, status: "ACTIVE", tokenPrefix: issued.tokenPrefix, agentVersion: input.agentVersion },
    });
  });

  const printerIds = await agentPrinterConfig({ ...ctx });
  logger.info("print_agent.paired", { requestId: meta.requestId, tenantId: candidate.tenantId, printAgentId: candidate.id });
  return { agentId: candidate.id, token: issued.token, printers: printerIds, pollIntervalMs: POLL_INTERVAL_MS, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS };
}

/** RH-AGT-02 — records the health the agent reports for its own printers. Foreign ids are ignored and logged. */
export async function recordHeartbeat(ctx: AgentContext, input: { agentVersion?: string; printers: ReadonlyArray<{ printerId: string; health: PrinterHealth; detail?: string | null }> }): Promise<{ serverTime: string; pollIntervalMs: number; heartbeatIntervalMs: number }> {
  const at = now();
  const { applied, ignored } = await applyPrinterHealth(ctx, input.printers, at);
  if (ignored.length > 0) {
    logger.warn("security.agent_foreign_printer_report", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: ctx.agentId, ignored: ignored.length });
  }
  logger.debug("print_agent.heartbeat", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: ctx.agentId, applied: applied.length });
  return { serverTime: at.toISOString(), pollIntervalMs: POLL_INTERVAL_MS, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS };
}

/**
 * RH-AGT-03 — atomic lease claim, restricted to the agent's tenant and its own printers. The response also hands over
 * a printer scan an admin asked this agent for (ADR-015), so no separate poll is needed.
 */
export async function claimPrintJobs(ctx: AgentContext, max: number): Promise<{ jobs: ClaimedJob[]; discovery: { discoveryId: string } | null }> {
  const at = now();
  const jobs = await claimJobs(ctx, max, at);
  const discoveryId = await takeRequestedDiscovery(ctx, new Date(at.getTime() - DISCOVERY_PICKUP_MS), at);
  if (discoveryId) logger.info("printer.discovery_started", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: ctx.agentId, discoveryId });
  if (jobs.length > 0) {
    logger.info("print_job.claimed", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: ctx.agentId, count: jobs.length });
  }
  return { jobs, discovery: discoveryId ? { discoveryId } : null };
}

/**
 * RH-AGT-04 — the only path to PRINTED (BR-PRINT-01). A terminal failure is audited as `print_job.failed` with the
 * agent as the actor; retries and successes are logged, not audited (they are high-frequency telemetry).
 */
export async function acknowledgePrintJob(
  ctx: AgentContext,
  jobId: string,
  input: { claimToken: string; result: "PRINTED" | "FAILED"; errorCode?: string; errorMessage?: string | null },
): Promise<{ jobId: string; status: PrintJobStatus }> {
  const at = now();
  const result = await ackJob(ctx, jobId, input.claimToken, { result: input.result, errorCode: input.errorCode ?? null, errorMessage: input.errorMessage ?? null }, at);

  if (result.terminalFailure) {
    await withTx(ctx, async (tx) => {
      await audit(tx, ctx, {
        action: "print_job.failed",
        resourceType: "print_job",
        resourceId: jobId,
        after: { status: result.status, attemptCount: result.attemptCount, errorCode: input.errorCode ?? "PRINT_FAILED" },
      });
    });
  }
  logger.info("print_job.acknowledged", {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    printAgentId: ctx.agentId,
    printJobId: jobId,
    status: result.status,
    changed: result.changed,
  });
  return { jobId, status: result.status };
}

/** RH-AGT-05 — the printers this agent is responsible for, and the intervals it should use. */
export async function getAgentConfig(ctx: AgentContext): Promise<{ agentId: string; printers: AgentPrinterConfig[]; pollIntervalMs: number; heartbeatIntervalMs: number }> {
  return {
    agentId: ctx.agentId,
    printers: await agentPrinterConfig(ctx),
    pollIntervalMs: POLL_INTERVAL_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

// ─── Kitchen dispatch after an order is placed (automatic KOT) ───

/**
 * What happened to one kitchen ticket's automatic print, as far as the server knows at that moment:
 * - QUEUED: a print job waits for an agent that is online (it normally prints within seconds).
 * - PRINTED: the agent already confirmed it (only ever set by the agent's acknowledgement, BR-PRINT-01).
 * - AGENT_OFFLINE: queued, but the printer's agent has not been seen for 90 s — it prints when the agent reconnects.
 * - FAILED: the job already failed permanently (retry from the printing console).
 * - NO_PRINTER: no active printer serves this kitchen section; the ticket is on the kitchen screen only.
 * - AUTO_PRINT_OFF: the restaurant turned automatic KOT printing off.
 * Never "printed" on assumption: the order itself succeeded either way (a printer never blocks an order).
 */
export type KotDispatchState = "QUEUED" | "PRINTED" | "AGENT_OFFLINE" | "FAILED" | "NO_PRINTER" | "AUTO_PRINT_OFF";
export type KitchenDispatch = {
  tickets: Array<{ kotNumber: string; sectionName: string | null; printerName: string | null; state: KotDispatchState }>;
};

export async function kitchenDispatchOfOrder(ctx: TenantContext, orderId: string, round = 1): Promise<KitchenDispatch> {
  const at = now();
  const { rows, autoPrintKot } = await withTx(ctx, async (tx) => ({
    rows: await kotDispatchOfOrder(tx, ctx, orderId, round),
    autoPrintKot: (await printingProfile(tx, ctx)).autoPrintKot,
  }));
  return {
    tickets: rows.map((row) => {
      let state: KotDispatchState;
      if (!row.job) state = autoPrintKot ? "NO_PRINTER" : "AUTO_PRINT_OFF";
      else if (row.job.status === PrintJobStatus.PRINTED) state = "PRINTED";
      else if (row.job.status === PrintJobStatus.FAILED) state = "FAILED";
      else if (!row.job.agentStatus || !isAgentOnline({ status: row.job.agentStatus, lastSeenAt: row.job.agentLastSeenAt }, at)) state = "AGENT_OFFLINE";
      else state = "QUEUED";
      return { kotNumber: row.kotNumber, sectionName: row.sectionName, printerName: row.job?.printerName ?? null, state };
    }),
  };
}

// ─── LAN printer discovery (RASOIOS-ADR-015) ───

/** A request not picked up within this window is reported as "agent not responding" (idle agents poll every ≤15 s). */
export const DISCOVERY_PICKUP_MS = 45_000;
/** A scan takes ~6 s; one still RUNNING after this is treated as failed. */
export const DISCOVERY_RUN_MS = 60_000;
const DISCOVERY_RATE_LIMIT = { limit: 6, windowSec: 60, failOpen: false } as const;

export type DiscoveryState = "REQUESTED" | "RUNNING" | "COMPLETED" | "FAILED" | "AGENT_NOT_RESPONDING";
export type DiscoveredPrinterView = DiscoveredPrinter & { alreadyAddedAs: string | null };
export type PrinterDiscoveryView = {
  id: string;
  agentId: string;
  state: DiscoveryState;
  errorCode: string | null;
  printers: DiscoveredPrinterView[];
  requestedAt: string;
};

function discoveryState(row: PrinterDiscoveryRow, at: Date): DiscoveryState {
  if (row.status === "REQUESTED" && at.getTime() - row.requestedAt.getTime() > DISCOVERY_PICKUP_MS) return "AGENT_NOT_RESPONDING";
  if (row.status === "RUNNING" && row.startedAt && at.getTime() - row.startedAt.getTime() > DISCOVERY_RUN_MS) return "FAILED";
  return row.status;
}

async function toDiscoveryView(ctx: TenantContext, row: PrinterDiscoveryRow): Promise<PrinterDiscoveryView> {
  const stored = Array.isArray(row.results) ? row.results : [];
  const printers = stored.flatMap((entry) => {
    const parsed = discoveredPrinterSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  // Mark devices this restaurant already uses, by the exact LAN address the printer row stores.
  const existing = new Map<string, string>();
  for (const printer of await listPrintersData(ctx)) {
    if (printer.connectionType === "LAN" && printer.connectionAddress && printer.isActive) {
      const [host, port] = printer.connectionAddress.split(":");
      existing.set(`${host}:${port ?? "9100"}`, printer.name);
    }
  }
  return {
    id: row.id,
    agentId: row.printAgentId,
    state: discoveryState(row, now()),
    errorCode: row.errorCode,
    printers: printers.map((p) => ({ ...p, alreadyAddedAs: existing.get(`${p.address}:${p.port}`) ?? null })),
    requestedAt: row.requestedAt.toISOString(),
  };
}

/** Thrown when the chosen agent cannot run a scan right now. */
export class AgentOfflineError extends ConflictError {
  constructor() {
    super("That print agent is offline. Start the agent on the restaurant PC and try again.", "AGENT_OFFLINE");
  }
}

/**
 * SA-PRN-07 — asks one of the caller's own online agents to scan its LAN. A second click while a scan is open returns
 * the same scan. Audited (it makes a device on the restaurant network send probes).
 */
export async function startPrinterDiscovery(ctx: TenantContext, agentId: string): Promise<PrinterDiscoveryView> {
  await enforceRateLimit("printer.discovery", ctx.userId, DISCOVERY_RATE_LIMIT, "Too many scans. Wait a minute and try again.");
  const at = now();
  const row = await withTx(ctx, async (tx) => {
    const agent = required(await findPrintAgentRow(tx, ctx, agentId), "Print agent");
    if (!isAgentOnline(agent, at)) throw new AgentOfflineError();
    const open = await findOpenDiscovery(tx, ctx, agentId, new Date(at.getTime() - DISCOVERY_PICKUP_MS));
    if (open) return open;
    const created = await insertDiscovery(tx, ctx, agentId, at);
    await audit(tx, ctx, { action: "printer.discovery_requested", resourceType: "printer_discovery", resourceId: created.id, after: { printAgentId: agentId } });
    return created;
  });
  logger.info("printer.discovery_requested", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: agentId, discoveryId: row.id });
  return toDiscoveryView(ctx, row);
}

/** LD-PRN-04 — the console polls this while the agent scans. */
export async function getPrinterDiscovery(ctx: TenantContext, discoveryId: string): Promise<PrinterDiscoveryView> {
  return toDiscoveryView(ctx, required(await findDiscovery(ctx, discoveryId), "Printer scan"));
}

/**
 * RH-AGT-06 — the agent's one report. Accepted only for a RUNNING scan of this agent (tenant and agent from the token);
 * anything else is 409, so a report can never land on another agent's or tenant's scan.
 */
export async function reportPrinterDiscovery(ctx: AgentContext, discoveryId: string, report: AgentDiscoveryReport): Promise<{ discoveryId: string; status: "COMPLETED" | "FAILED" }> {
  // One entry per address:port — a device found by mDNS and by the port probe is one device.
  const unique = new Map<string, DiscoveredPrinter>();
  for (const printer of report.printers) unique.set(`${printer.address}:${printer.port}`, printer);
  const status = report.outcome;
  const saved = await completeDiscovery(
    ctx,
    discoveryId,
    { status, results: [...unique.values()] as unknown as Prisma.InputJsonValue, errorCode: status === "FAILED" ? (report.errorCode ?? "DISCOVERY_FAILED") : null },
    now(),
  );
  if (!saved) throw new ConflictError("This scan is not running on this agent.", "DISCOVERY_NOT_RUNNING");
  logger.info("printer.discovery_reported", { requestId: ctx.requestId, tenantId: ctx.tenantId, printAgentId: ctx.agentId, discoveryId, status, found: unique.size });
  return { discoveryId, status };
}
