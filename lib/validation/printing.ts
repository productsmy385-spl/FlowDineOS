/**
 * Printing and print-agent inputs (S1-P16-T004/T005; api.md LD-PRN-01, RH-PRN-01, SA-PRN-01…06, SA-AGT-01/02,
 * RH-AGT-01…05). Every schema is strict: a `tenantId`, `payload`, `jobType` or `status` sent by a client or an agent
 * is rejected with 422 (SC-VAL-01, SC-TEN-01, ADR-007 §1).
 *
 * LAN addresses are restricted to literal private IPv4 addresses (SC-PRINT-06). The cloud never opens a connection to
 * a printer — the local agent does — but a public address or a hostname stored here would turn the console into a
 * request-forgery primitive the moment anything followed it, so it is refused at the boundary.
 */
import { PrintJobStatus, PrintJobType, PrinterConnection, PrinterHealth, PrinterPurpose } from "@prisma/client";
import { z } from "zod";
import { isPrivateIpv4, isPrivateLanAddress, USB_ADDRESS_PATTERN } from "@/lib/print/address";
import { PRINTER_PROFILE_KEYS, type PrinterProfileKey } from "@/lib/print/profiles";
import { boundedText, optionalText, strictObject, uuidParam } from "./core";

// ─── Printer addresses (SC-PRINT-06) — shared with the local agent via lib/print/address.ts ───

export { isPrivateIpv4, isPrivateLanAddress, isValidPort, USB_ADDRESS_PATTERN } from "@/lib/print/address";

export const LAN_ADDRESS_MESSAGE = "Use a private LAN address such as 192.168.1.50:9100 (10.x, 172.16–31.x or 192.168.x only).";
export const USB_ADDRESS_MESSAGE = "Use the USB device or print-queue name, e.g. USB001.";

export function connectionAddressIssue(connectionType: PrinterConnection, address: string): string | null {
  if (connectionType === PrinterConnection.LAN) return isPrivateLanAddress(address) ? null : LAN_ADDRESS_MESSAGE;
  return USB_ADDRESS_PATTERN.test(address) ? null : USB_ADDRESS_MESSAGE;
}

// ─── Console reads (LD-PRN-01, RH-PRN-01) ───

export const printJobFiltersSchema = strictObject({
  status: z.nativeEnum(PrintJobStatus).optional(),
  jobType: z.nativeEnum(PrintJobType).optional(),
});
export type PrintJobFiltersInput = z.input<typeof printJobFiltersSchema>;

/** RH-PRN-01 `GET /api/v1/print-jobs?since=&status=&jobType=` — `since` is the previous response's `serverTime`. */
export const printJobPollSchema = strictObject({
  since: z.string().datetime({ offset: true }).optional(),
  status: z.nativeEnum(PrintJobStatus).optional(),
  jobType: z.nativeEnum(PrintJobType).optional(),
});
export type PrintJobPollInput = z.input<typeof printJobPollSchema>;

// ─── Printers (SA-PRN-01…04) ───

const paperWidthField = z.union([z.literal(58), z.literal(80)], { errorMap: () => ({ message: "Choose 58 mm or 80 mm" }) });
const addressField = boundedText(255, { label: "Connection address" });

/** A capability profile key (lib/print/profiles.ts). */
const profileField = z.enum(PRINTER_PROFILE_KEYS as [PrinterProfileKey, ...PrinterProfileKey[]], { errorMap: () => ({ message: "Choose a printer model" }) });

export const createPrinterSchema = strictObject({
  name: boundedText(60, { label: "Printer name" }),
  purpose: z.nativeEnum(PrinterPurpose),
  connectionType: z.nativeEnum(PrinterConnection),
  connectionAddress: addressField,
  paperWidthMm: paperWidthField,
  kitchenSectionId: uuidParam.nullish().transform((value) => value ?? null),
  printAgentId: uuidParam.nullish().transform((value) => value ?? null),
  profile: profileField.optional(),
}).superRefine((value, ctx) => {
  const issue = connectionAddressIssue(value.connectionType, value.connectionAddress);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connectionAddress"], message: issue });
});
export type CreatePrinterInput = z.input<typeof createPrinterSchema>;

export const updatePrinterSchema = strictObject({
  printerId: uuidParam,
  name: boundedText(60, { label: "Printer name" }).optional(),
  purpose: z.nativeEnum(PrinterPurpose).optional(),
  connectionType: z.nativeEnum(PrinterConnection).optional(),
  connectionAddress: addressField.optional(),
  paperWidthMm: paperWidthField.optional(),
  // `null` clears the assignment, an omitted key leaves it untouched — so a partial edit cannot silently unassign a
  // station or an agent.
  kitchenSectionId: uuidParam.nullable().optional(),
  printAgentId: uuidParam.nullable().optional(),
  profile: profileField.optional(),
}).superRefine((value, ctx) => {
  if (value.connectionAddress === undefined) return;
  if (value.connectionType === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connectionType"], message: "Send the connection type with a new address." });
    return;
  }
  const issue = connectionAddressIssue(value.connectionType, value.connectionAddress);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connectionAddress"], message: issue });
});
export type UpdatePrinterInput = z.input<typeof updatePrinterSchema>;

export const printerIdSchema = strictObject({ printerId: uuidParam });
export type PrinterIdInput = z.input<typeof printerIdSchema>;

/** SA-PRN-04 — the server builds the TEST payload; the client only picks one of its tenant's printers. */
export const testPrintSchema = printerIdSchema;
export type TestPrintInput = z.input<typeof testPrintSchema>;

// ─── Jobs (SA-PRN-05, SA-PRN-06, SA-KOT-02) ───

export const retryPrintJobSchema = strictObject({ jobId: uuidParam });
export type RetryPrintJobInput = z.input<typeof retryPrintJobSchema>;

/** Cancel a queued, retrying or failed job (2026-10-08); the reason is optional and kept on the job. */
export const cancelPrintJobSchema = strictObject({ jobId: uuidParam, reason: optionalText(200, "Reason") });
export type CancelPrintJobInput = z.input<typeof cancelPrintJobSchema>;

/** Test connection of one printer, and reading one check back (2026-10-08). */
export const printerCheckIdSchema = strictObject({ checkId: uuidParam });
export type PrinterCheckIdInput = z.input<typeof printerCheckIdSchema>;

/** RH-AGT-07 — the agent's result of one connection check. */
export const agentCheckReportSchema = strictObject({
  ok: z.boolean(),
  errorCode: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use an UPPER_SNAKE_CASE error code")
    .optional(),
  detail: optionalText(200, "Detail"),
  elapsedMs: z.number().int().min(0).max(120_000),
});
export type AgentCheckReportInput = z.input<typeof agentCheckReportSchema>;

/** RASOIOS-ADR-022 — remove finished jobs from the history: chosen ones, or all older than N days. */
export const archivePrintJobsSchema = z.union([
  strictObject({ jobIds: z.array(uuidParam).min(1, "Choose at least one job").max(100, "Up to 100 jobs at a time") }),
  strictObject({ olderThanDays: z.number().int().min(1).max(365) }),
]);
export type ArchivePrintJobsInput = z.input<typeof archivePrintJobsSchema>;

export const printReceiptSchema = strictObject({ orderId: uuidParam });
export type PrintReceiptInput = z.input<typeof printReceiptSchema>;

export const reprintKotSchema = strictObject({ kotId: uuidParam });
export type ReprintKotInput = z.input<typeof reprintKotSchema>;

// ─── Agents (SA-AGT-01, SA-AGT-02) ───

/** 8 characters from a 32-symbol alphabet without the ambiguous I, O, 0 and 1 (ADR-007 §1, SC-PRINT-02). */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

export const createPrintAgentSchema = strictObject({ name: boundedText(60, { label: "Agent name" }) });
export type CreatePrintAgentInput = z.input<typeof createPrintAgentSchema>;

export const printAgentIdSchema = strictObject({ agentId: uuidParam });
export type PrintAgentIdInput = z.input<typeof printAgentIdSchema>;

// ─── Agent API (RH-AGT-01…05) ───

/** RH-AGT-01 pair. The code is normalised before hashing so a technician may type it in lower case. */
export const agentPairSchema = strictObject({
  pairingCode: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
    .pipe(z.string().regex(PAIRING_CODE_PATTERN, "Invalid pairing code")),
  agentVersion: boundedText(32, { label: "Agent version" }),
  osInfo: boundedText(64, { label: "OS info" }),
});
export type AgentPairInput = z.input<typeof agentPairSchema>;

/** RH-AGT-02 heartbeat. Printer ids that are not assigned to the calling agent are ignored and logged, never applied. */
export const agentHeartbeatSchema = strictObject({
  agentVersion: boundedText(32, { label: "Agent version" }).optional(),
  printers: z
    .array(
      strictObject({
        printerId: uuidParam,
        health: z.nativeEnum(PrinterHealth),
        detail: optionalText(120, "Detail"),
      }),
    )
    .max(50)
    .default([]),
});
export type AgentHeartbeatInput = z.input<typeof agentHeartbeatSchema>;

/** RH-AGT-03 claim. */
export const agentClaimSchema = strictObject({ max: z.number().int().min(1).max(10).default(1) });
export type AgentClaimInput = z.input<typeof agentClaimSchema>;

/** RH-AGT-04 acknowledge. `PRINTED` here is the only way a job becomes PRINTED (ADR-007 §4, BR-PRINT-01). */
export const agentAckSchema = strictObject({
  claimToken: uuidParam,
  result: z.enum(["PRINTED", "FAILED"]),
  errorCode: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use an UPPER_SNAKE_CASE error code")
    .optional(),
  errorMessage: optionalText(500, "Error message"),
});
export type AgentAckInput = z.input<typeof agentAckSchema>;

export const agentJobParamsSchema = strictObject({ jobId: uuidParam });
export type AgentJobParamsInput = z.input<typeof agentJobParamsSchema>;

// ─── LAN printer discovery (RASOIOS-ADR-015) ───

/** SA-PRN-07 — start a scan on one of the caller's agents. The agent id is re-checked against the caller's tenant. */
export const startPrinterDiscoverySchema = strictObject({ agentId: uuidParam });
export type StartPrinterDiscoveryInput = z.input<typeof startPrinterDiscoverySchema>;

/** LD-PRN-04 — read one scan of the caller's tenant. */
export const printerDiscoveryIdSchema = strictObject({ discoveryId: uuidParam });
export type PrinterDiscoveryIdInput = z.input<typeof printerDiscoveryIdSchema>;

export const DISCOVERY_MAX_RESULTS = 64;
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

/**
 * One device the agent observed. Untrusted input from a device on a restaurant LAN (SC-VAL-07): only private IPv4,
 * bounded text, known protocol values. `rawPrinting` means port-9100 raw printing answered or was advertised.
 */
export const discoveredPrinterSchema = strictObject({
  address: z.string().refine(isPrivateIpv4, "Only private IPv4 addresses are accepted"),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["RAW_9100", "IPP"]),
  rawPrinting: z.boolean(),
  name: shortText(80),
  manufacturer: shortText(60),
  model: shortText(80),
  sources: z.array(z.enum(["MDNS", "PORT_PROBE"])).min(1).max(2),
});
export type DiscoveredPrinter = z.output<typeof discoveredPrinterSchema>;

/** RH-AGT-06 — the agent's single report for a scan it picked up. */
export const agentDiscoveryReportSchema = strictObject({
  outcome: z.enum(["COMPLETED", "FAILED"]),
  errorCode: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use an UPPER_SNAKE_CASE error code")
    .optional(),
  printers: z.array(discoveredPrinterSchema).max(DISCOVERY_MAX_RESULTS).default([]),
});
export type AgentDiscoveryReportInput = z.input<typeof agentDiscoveryReportSchema>;
export type AgentDiscoveryReport = z.output<typeof agentDiscoveryReportSchema>;

export const agentDiscoveryParamsSchema = strictObject({ discoveryId: uuidParam });
