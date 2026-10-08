import { PrintJobStatus, type PrintJobType } from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import { PRINT_ERRORS, canonicalPrintErrorCode, type PrintErrorCode } from "@/lib/print/error-codes";

/**
 * PRINT_JOB state machine (S1-P16-T001, architecture.md §6.3, ADR-007 §3–4; printing audit 2026-10-08). Pure functions —
 * no database, no clock beyond the instant the caller passes in — so the queue's rules are unit-testable on their own.
 *
 *   PENDING    → PROCESSING (agent claim, lease 60 s, attempt + 1)
 *   PENDING    → FAILED     (printer deactivated)
 *   PENDING    → CANCELLED  (staff cancel while queued or waiting to retry)
 *   PROCESSING → PRINTED    (agent ack: delivered to the printer — the only path to PRINTED, BR-PRINT-01)
 *   PROCESSING → PENDING    (ack FAILED and still inside the retry window, or an expired lease returning the job)
 *   PROCESSING → FAILED     (ack FAILED and not retryable, out of attempts, or past the retry window)
 *   FAILED     → PENDING    (staff retry, attempts reset)
 *   FAILED     → CANCELLED  (staff dismiss a failed job)
 *   PRINTED, CANCELLED → —  (terminal)
 *
 * A job in flight (PROCESSING) is never cancelled: the agent may already be sending it to the printer.
 */
export const PRINT_JOB_TRANSITIONS: Readonly<Record<PrintJobStatus, readonly PrintJobStatus[]>> = {
  PENDING: [PrintJobStatus.PROCESSING, PrintJobStatus.FAILED, PrintJobStatus.CANCELLED],
  PROCESSING: [PrintJobStatus.PRINTED, PrintJobStatus.PENDING, PrintJobStatus.FAILED],
  PRINTED: [],
  FAILED: [PrintJobStatus.PENDING, PrintJobStatus.CANCELLED],
  CANCELLED: [],
};

export function canTransition(from: PrintJobStatus, to: PrintJobStatus): boolean {
  return PRINT_JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PrintJobStatus, to: PrintJobStatus): void {
  if (!canTransition(from, to)) throw new ConflictError(`A ${from.toLowerCase()} print job cannot become ${to.toLowerCase()}.`, "INVALID_TRANSITION");
}

/** Lease length of one claim (ADR-007 §3). An expired lease makes the job claimable again. */
export const LEASE_MS = 60_000;

/**
 * How long, how often and how many times each kind of job is retried automatically (owner decision 2026-10-08).
 * A kitchen ticket keeps trying for 30 minutes so a printer that is switched back on still gets it; the delays grow so
 * an offline printer is not hammered. Receipts stop after 5 minutes; a test page fails fast so its result is useful.
 */
export type RetryPolicy = { windowMs: number; maxAttempts: number; delaysMs: readonly number[] };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
export const RETRY_POLICIES: Readonly<Record<PrintJobType, RetryPolicy>> = {
  KOT: { windowMs: 30 * MINUTE, maxAttempts: 30, delaysMs: [5 * SECOND, 10 * SECOND, 20 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE] },
  RECEIPT: { windowMs: 5 * MINUTE, maxAttempts: 8, delaysMs: [5 * SECOND, 10 * SECOND, 20 * SECOND, 30 * SECOND, MINUTE] },
  TEST: { windowMs: 30 * SECOND, maxAttempts: 2, delaysMs: [5 * SECOND] },
};

/** Delay before the next attempt; `attemptCount` is the count *after* the failed attempt (1 → first delay). */
export function retryDelayMs(jobType: PrintJobType, attemptCount: number): number {
  const delays = RETRY_POLICIES[jobType].delaysMs;
  return delays[Math.min(Math.max(attemptCount, 1), delays.length) - 1];
}

export type FailureInput = { jobType: PrintJobType; attemptCount: number; maxAttempts: number; createdAt: Date; errorCode?: string | null; errorMessage?: string | null };
export type FailureOutcome = { status: PrintJobStatus; nextAttemptAt: Date | null; errorCode: PrintErrorCode; gaveUp: boolean };

/**
 * What an agent's FAILED acknowledgement does. Retried with the job type's delays while the error can be fixed by trying
 * again and the job is inside its retry window and under its attempt cap; otherwise terminal FAILED. Running out of
 * window or attempts is recorded as PRINT_JOB_EXPIRED (the cause stays in the message), so the console can say "retries
 * stopped" instead of repeating the last network error.
 */
export function outcomeOfFailure(job: FailureInput, at: Date): FailureOutcome {
  const cause = canonicalPrintErrorCode(job.errorCode, job.errorMessage);
  if (!PRINT_ERRORS[cause].retryable) return { status: PrintJobStatus.FAILED, nextAttemptAt: null, errorCode: cause, gaveUp: false };
  const policy = RETRY_POLICIES[job.jobType];
  const next = new Date(at.getTime() + retryDelayMs(job.jobType, job.attemptCount));
  const withinWindow = next.getTime() <= job.createdAt.getTime() + policy.windowMs;
  if (job.attemptCount < job.maxAttempts && withinWindow) return { status: PrintJobStatus.PENDING, nextAttemptAt: next, errorCode: cause, gaveUp: false };
  return { status: PrintJobStatus.FAILED, nextAttemptAt: null, errorCode: "PRINT_JOB_EXPIRED", gaveUp: true };
}

/** Error codes the server itself records (agents send their own, normalised on the way in). */
export const PRINT_ERROR_CODES = {
  PRINTER_DEACTIVATED: "PRINTER_DISABLED",
  LEASE_EXPIRED: "LEASE_EXPIRED",
} as const;

/**
 * What staff see for a job (owner brief 2026-10-08 §10): "Delivered" rather than "Printed", because a raw TCP printer
 * does not confirm paper; a queued job that has already failed once is "Retrying".
 */
export type PrintJobDisplayStatus = "QUEUED" | "PRINTING" | "RETRYING" | "DELIVERED" | "FAILED" | "CANCELLED";

export function displayStatus(job: { status: PrintJobStatus; attemptCount: number; lastErrorCode: string | null }): PrintJobDisplayStatus {
  switch (job.status) {
    case "PENDING":
      return job.attemptCount > 0 && job.lastErrorCode ? "RETRYING" : "QUEUED";
    case "PROCESSING":
      return "PRINTING";
    case "PRINTED":
      return "DELIVERED";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
  }
}
