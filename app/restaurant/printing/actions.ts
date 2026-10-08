"use server";

import { requirePermission, requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import {
  archivePrintHistory,
  cancelPrintJob,
  closeStalePairings,
  getPrinterCheck,
  setPrinterArchive,
  startPrinterCheck,
  createPrintAgentPairing,
  createPrinter,
  createTestPrintJob,
  deactivatePrinter,
  getPrinterDiscovery,
  getPrintingConsole,
  listActivePrinters,
  listAgents,
  listPrintJobs,
  listPrinters,
  printReceipt,
  reprintKot,
  retryPrintJob,
  revokePrintAgent,
  startPrinterDiscovery,
  updatePrinter,
} from "@/lib/services/printing";
import { parseInput } from "@/lib/validation/core";
import {
  archivePrintJobsSchema,
  cancelPrintJobSchema,
  printerCheckIdSchema,
  type CancelPrintJobInput,
  type PrinterCheckIdInput,
  createPrintAgentSchema,
  createPrinterSchema,
  printAgentIdSchema,
  printerDiscoveryIdSchema,
  startPrinterDiscoverySchema,
  printJobFiltersSchema,
  printReceiptSchema,
  printerIdSchema,
  reprintKotSchema,
  retryPrintJobSchema,
  testPrintSchema,
  updatePrinterSchema,
  type CreatePrintAgentInput,
  type CreatePrinterInput,
  type PrintAgentIdInput,
  type PrintJobFiltersInput,
  type PrintReceiptInput,
  type PrinterIdInput,
  type ReprintKotInput,
  type ArchivePrintJobsInput,
  type RetryPrintJobInput,
  type TestPrintInput,
  type UpdatePrinterInput,
  type PrinterDiscoveryIdInput,
  type StartPrinterDiscoveryInput,
} from "@/lib/validation/printing";

/**
 * Printing console actions (S1-P16-T003/T004/T006/T007; api.md LD-PRN-01, SA-PRN-01…06, SA-AGT-01/02, SA-KOT-02).
 *
 * Every action starts with its guard, so the permission is checked before any resource is loaded and a 403 can never
 * reveal whether a printer, agent or job exists (security.md §1 steps 4–5, §3.3 rows 44–47). The tenant comes from
 * the session only; inputs are strict objects, so a `tenantId` sent by a client is 422 rather than a filter.
 */

// ─── Reads (LD-PRN-01) ───

/** LD-PRN-01 — agents, printers and the queue in one call — `print_job:read`. */
export const getPrintingConsoleAction = action(async (input: PrintJobFiltersInput = {}) => {
  const ctx = await requireTenant("print_job:read");
  const filters = parseInput(printJobFiltersSchema, input);
  return getPrintingConsole(ctx, filters);
});

/** The print queue alone — `print_job:read`. */
export const getPrintJobsAction = action(async (input: PrintJobFiltersInput = {}) => {
  const ctx = await requireTenant("print_job:read");
  const filters = parseInput(printJobFiltersSchema, input);
  return listPrintJobs(ctx, filters);
});

/** Active printers, for target lists — `print_job:read`. */
export const getPrintersAction = action(async () => {
  const ctx = await requireTenant("print_job:read");
  return listActivePrinters(ctx);
});

/** Every printer including deactivated ones (Printers tab) — `printer:manage`. */
export const getAllPrintersAction = action(async () => {
  const ctx = await requireTenant("printer:manage");
  return listPrinters(ctx);
});

/** Agents with a derived online flag (Agents tab) — `print_agent:manage`. */
export const getPrintAgentsAction = action(async () => {
  const ctx = await requireTenant("print_agent:manage");
  return listAgents(ctx);
});

// ─── Printers (SA-PRN-01…04) ───

/** SA-PRN-01 create a printer — `printer:manage`. */
export const createPrinterAction = action(async (input: CreatePrinterInput) => {
  const ctx = await requireTenant("printer:manage");
  const data = parseInput(createPrinterSchema, input);
  return createPrinter(ctx, data);
});

/** SA-PRN-02 update a printer — `printer:manage`. */
export const updatePrinterAction = action(async (input: UpdatePrinterInput) => {
  const ctx = await requireTenant("printer:manage");
  const data = parseInput(updatePrinterSchema, input);
  return updatePrinter(ctx, data);
});

/** SA-PRN-03 deactivate a printer; its PENDING jobs fail with `PRINTER_DEACTIVATED` — `printer:manage`. */
export const deactivatePrinterAction = action(async (input: PrinterIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { printerId } = parseInput(printerIdSchema, input);
  return deactivatePrinter(ctx, printerId);
});

/** SA-PRN-04 test print to one of the tenant's printers — `printer:manage`. */
export const createTestPrintJobAction = action(async (input: TestPrintInput) => {
  const ctx = await requireTenant("printer:manage");
  const { printerId } = parseInput(testPrintSchema, input);
  return createTestPrintJob(ctx, printerId);
});

// ─── Jobs (SA-PRN-05, SA-PRN-06, SA-KOT-02) ───

/** SA-PRN-05 retry a FAILED job — `print_job:retry`. */
export const retryPrintJobAction = action(async (input: RetryPrintJobInput) => {
  const ctx = await requireTenant("print_job:retry");
  const { jobId } = parseInput(retryPrintJobSchema, input);
  return retryPrintJob(ctx, jobId);
});

/** SA-PRN-09 remove finished jobs from the history — `printer:manage` (owner/administrator and manager). */
export const archivePrintJobsAction = action(async (input: ArchivePrintJobsInput) => {
  const ctx = await requireTenant("printer:manage");
  return archivePrintHistory(ctx, parseInput(archivePrintJobsSchema, input));
});

/** SA-PRN-06 queue an order's receipt — `print_job:retry` and `transaction:read` (api.md SA-PRN-06). */
export const printReceiptAction = action(async (input: PrintReceiptInput) => {
  const ctx = await requireTenant("print_job:retry");
  requirePermission(ctx, "transaction:read");
  const { orderId } = parseInput(printReceiptSchema, input);
  return printReceipt(ctx, orderId);
});

/** SA-KOT-02 reprint a kitchen ticket — `kot:reprint`. The ticket's own print status is unchanged. */
export const reprintKotAction = action(async (input: ReprintKotInput) => {
  const ctx = await requireTenant("kot:reprint");
  const { kotId } = parseInput(reprintKotSchema, input);
  return reprintKot(ctx, kotId);
});

// ─── Agents (SA-AGT-01, SA-AGT-02) ───

/** SA-AGT-01 create a pairing; the code is returned once and only its hash is stored — `print_agent:manage`. */
export const createPrintAgentPairingAction = action(async (input: CreatePrintAgentInput) => {
  const ctx = await requireTenant("print_agent:manage");
  const { name } = parseInput(createPrintAgentSchema, input);
  return createPrintAgentPairing(ctx, name);
});

/** SA-AGT-02 revoke an agent; its next call is 401 — `print_agent:manage`. */
export const revokePrintAgentAction = action(async (input: PrintAgentIdInput) => {
  const ctx = await requireTenant("print_agent:manage");
  const { agentId } = parseInput(printAgentIdSchema, input);
  return revokePrintAgent(ctx, agentId);
});

// ─── LAN printer discovery (RASOIOS-ADR-015) ───

/** SA-PRN-07 — ask one of the tenant's online agents to scan its LAN — `printer:manage`. */
export const startPrinterDiscoveryAction = action(async (input: StartPrinterDiscoveryInput) => {
  const ctx = await requireTenant("printer:manage");
  const { agentId } = parseInput(startPrinterDiscoverySchema, input);
  return startPrinterDiscovery(ctx, agentId);
});

/** LD-PRN-04 — the scan's state and what it found — `printer:manage`. */
export const getPrinterDiscoveryAction = action(async (input: PrinterDiscoveryIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { discoveryId } = parseInput(printerDiscoveryIdSchema, input);
  return getPrinterDiscovery(ctx, discoveryId);
});

// ─── Printing hardening (knowledge/implementation/printing-audit-2026-10-08.md) ───

/** Test connection — the printer's own agent opens and closes a TCP connection; nothing is printed — `printer:manage`. */
export const startPrinterCheckAction = action(async (input: PrinterIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { printerId } = parseInput(printerIdSchema, input);
  return startPrinterCheck(ctx, printerId);
});

/** Polled by the console while the agent tests — `printer:manage`. */
export const getPrinterCheckAction = action(async (input: PrinterCheckIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { checkId } = parseInput(printerCheckIdSchema, input);
  return getPrinterCheck(ctx, checkId);
});

/**
 * Cancel a queued, retrying or failed job — `printer:manage` (owner/administrator and manager). Kitchen and counter staff
 * can retry a ticket but not withdraw one.
 */
export const cancelPrintJobAction = action(async (input: CancelPrintJobInput) => {
  const ctx = await requireTenant("printer:manage");
  const { jobId, reason } = parseInput(cancelPrintJobSchema, input);
  return cancelPrintJob(ctx, jobId, reason ?? null);
});

/** Archive a deactivated printer (hidden from the list; row and history kept) — `printer:manage`. */
export const archivePrinterAction = action(async (input: PrinterIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { printerId } = parseInput(printerIdSchema, input);
  return setPrinterArchive(ctx, printerId, true);
});

/** Show an archived printer again (still deactivated) — `printer:manage`. */
export const restorePrinterAction = action(async (input: PrinterIdInput) => {
  const ctx = await requireTenant("printer:manage");
  const { printerId } = parseInput(printerIdSchema, input);
  return setPrinterArchive(ctx, printerId, false);
});

/** Close every pairing attempt whose code has expired (nothing deleted) — `print_agent:manage`. */
export const closeStalePairingsAction = action(async () => {
  const ctx = await requireTenant("print_agent:manage");
  return closeStalePairings(ctx);
});
