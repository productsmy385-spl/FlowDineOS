import { profileOf } from "@/lib/print/profiles";
import { parsePrintDocument } from "@/lib/print/types";
import { AgentApiError, type AckBody, type AgentApiLike, type AgentPrinter, type ClaimedJob, type DiscoveredDevice, type PrinterCheckRequest, type PrinterHealthValue } from "./api";
import { discoverPrinters } from "./discovery";
import { encodeDocument } from "./escpos";
import type { PrintedJournal } from "./journal";
import type { Logger } from "./logger";
import { PrintTransportError, type Transport } from "./transports";
import { UNREACHABLE_CODES } from "./transports/types";
import { AGENT_VERSION } from "./version";

/**
 * The poll → claim → print → acknowledge loop (S1-P17-T004, ADR-007 §3–§7).
 *
 * - Heartbeat (with each printer's probed health) and a config refresh every `heartbeatIntervalMs` (server: 30 s).
 * - One lane per printer (printing audit 2026-10-08 P1): a claim returns at most one job per printer, and printers are
 *   served in parallel — an unreachable kitchen printer never delays the bar printer. A printer's own tickets stay in
 *   order. When jobs came back, claim again straight away; when the queue is empty, wait the poll interval (3 s ± 1 s
 *   jitter), backing off to 15 s after 10 empty polls. One job per printer per claim keeps every lease short.
 * - Network or server failure: exponential backoff 1 s → 60 s. 429: wait what the server says.
 * - 401: the token was revoked — stop with {@link FatalAgentError}; the service manager must not restart-loop on it.
 * - The journal is checked before printing and written before acknowledging (at-least-once with duplicate mitigation).
 * - Stop requests are honoured between jobs, so an in-flight ticket always finishes.
 */
export const EMPTY_POLLS_BEFORE_BACKOFF = 10;
export const IDLE_POLL_MS = 15_000;
export const MAX_NETWORK_BACKOFF_MS = 60_000;
/** The server caps a claim at 10 jobs. */
export const MAX_CLAIM = 10;
const ACK_ATTEMPTS = 4;

export type RunnerState =
  | "STARTING"
  | "CONNECTING"
  | "ONLINE"
  | "RECONNECTING"
  | "AUTHENTICATION_REQUIRED"
  | "REVOKED"
  | "STOPPING";

export class FatalAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalAgentError";
  }
}

export type RunnerDeps = {
  api: AgentApiLike;
  journal: PrintedJournal;
  logger: Logger;
  transportFor: (printer: AgentPrinter) => Transport;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** LAN printer scan (RASOIOS-ADR-015); injectable for tests. */
  discover?: () => Promise<DiscoveredDevice[]>;
};

type Health = { health: PrinterHealthValue; detail?: string };

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class PrintAgentRunner {
  readonly printers = new Map<string, AgentPrinter>();
  readonly health = new Map<string, Health>();
  pollIntervalMs = 3_000;
  heartbeatIntervalMs = 30_000;
  private state: RunnerState = "STARTING";
  private emptyPolls = 0;
  private networkFailures = 0;
  private consecutiveAuthFailures = 0;
  private nextHeartbeatAt = 0;
  /** A heartbeat probes every printer; after the first one it runs beside the claim loop, never in front of it. */
  private heartbeatInFlight: Promise<void> | null = null;
  private heartbeatError: unknown = null;

  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
    this.random = deps.random ?? Math.random;
  }

  getState(): RunnerState {
    return this.state;
  }

  private setState(next: RunnerState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.deps.logger.info("agent.state_changed", { from: prev, to: next });
  }

  /** Runs until `signal` aborts. Throws {@link FatalAgentError} when the agent must be re-paired. */
  async run(signal: AbortSignal): Promise<void> {
    this.setState("STARTING");
    this.deps.logger.info("agent.started", { version: AGENT_VERSION });
    while (!signal.aborted) {
      const delay = await this.cycle();
      if (delay > 0) await this.sleep(delay, signal);
    }
    this.setState("STOPPING");
    this.deps.logger.info("agent.stopped");
  }

  /** One iteration: heartbeat when due, then one claim. Returns how long to wait before the next iteration. */
  async cycle(): Promise<number> {
    try {
      if (this.heartbeatError !== null) {
        // A background heartbeat failed (server down, or the token was revoked): handle it like any other failure.
        const error = this.heartbeatError;
        this.heartbeatError = null;
        throw error;
      }
      if (this.state === "STARTING" || this.state === "RECONNECTING") {
        this.setState("CONNECTING");
      }
      if (this.now() >= this.nextHeartbeatAt && this.heartbeatInFlight === null) {
        this.nextHeartbeatAt = this.now() + this.heartbeatIntervalMs;
        if (this.printers.size === 0) {
          // The first heartbeat loads the printer list the claim depends on, so it is awaited.
          await this.heartbeat();
        } else {
          // Later ones probe printers in the background: an unreachable printer's 5 s connect timeout must never hold
          // up the tickets of the other printers (printing audit 2026-10-08).
          this.heartbeatInFlight = this.heartbeat()
            .catch((error: unknown) => {
              this.heartbeatError = error;
            })
            .finally(() => {
              this.heartbeatInFlight = null;
            });
        }
      }
      const wasReconnecting = this.networkFailures > 0;
      const { jobs, discovery, checks } = await this.deps.api.claim(Math.min(MAX_CLAIM, Math.max(1, this.printers.size)));
      this.setState("ONLINE");
      if (wasReconnecting) {
        this.nextHeartbeatAt = 0;
      }
      this.networkFailures = 0;
      this.consecutiveAuthFailures = 0;
      if (checks && checks.length > 0) await this.runChecks(checks);
      if (discovery) await this.runDiscovery(discovery.discoveryId);
      if (jobs.length > 0) {
        this.emptyPolls = 0;
        const lanes = new Map<string, ClaimedJob[]>();
        for (const job of jobs) lanes.set(job.printerId, [...(lanes.get(job.printerId) ?? []), job]);
        // Different printers in parallel; one printer's jobs in order. A failure in one lane never stops another.
        const results = await Promise.allSettled([...lanes.values()].map(async (lane) => {
          for (const job of lane) await this.process(job);
        }));
        const fatal = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && result.reason instanceof FatalAgentError);
        if (fatal) throw fatal.reason;
        for (const result of results) {
          if (result.status === "rejected") this.deps.logger.error("job.lane_failed", { error: result.reason instanceof Error ? result.reason.name : "UNKNOWN" });
        }
        return 0;
      }
      this.emptyPolls += 1;
      if (this.emptyPolls >= EMPTY_POLLS_BEFORE_BACKOFF) return IDLE_POLL_MS;
      return Math.max(250, this.pollIntervalMs + Math.round((this.random() * 2 - 1) * 1_000));
    } catch (error) {
      return this.failureDelay(error);
    }
  }

  private failureDelay(error: unknown): number {
    if (error instanceof AgentApiError) {
      if (error.kind === "AUTH") {
        this.setState(error.code === "REVOKED_AGENT_TOKEN" ? "REVOKED" : "AUTHENTICATION_REQUIRED");
        throw new FatalAgentError("The server rejected this agent's token (revoked or replaced). Pair the agent again.");
      }
      if (error.kind === "RATE_LIMITED") {
        this.setState("RECONNECTING");
        this.deps.logger.warn("agent.rate_limited", { retryAfterMs: error.retryAfterMs });
        return error.retryAfterMs ?? 30_000;
      }
    }
    this.setState("RECONNECTING");
    this.networkFailures += 1;
    const baseDelay = Math.min(MAX_NETWORK_BACKOFF_MS, 1_000 * 2 ** (this.networkFailures - 1));
    const jitterRatio = 1 + (this.random() - 0.5) * 0.2;
    const delay = Math.max(500, Math.min(MAX_NETWORK_BACKOFF_MS, Math.round(baseDelay * jitterRatio)));
    this.deps.logger.warn("agent.server_unavailable", {
      kind: error instanceof AgentApiError ? error.kind : "UNKNOWN",
      status: error instanceof AgentApiError ? error.status : null,
      consecutiveFailures: this.networkFailures,
      retryInMs: delay,
    });
    return delay;
  }

  /** Refreshes the printer list from RH-AGT-05 and reports each printer's probed health through RH-AGT-02. */
  async heartbeat(): Promise<void> {
    try {
      await this.refreshConfig();
    } catch (error) {
      if (error instanceof AgentApiError && error.kind === "AUTH") throw error;
      this.deps.logger.warn("agent.config_refresh_failed", {
        kind: error instanceof AgentApiError ? error.kind : "UNKNOWN",
        error: error instanceof Error ? error.message : "UNKNOWN",
      });
    }
    await Promise.all([...this.printers.values()].map((printer) => this.probe(printer)));
    const reply = await this.deps.api.heartbeat({
      agentVersion: AGENT_VERSION,
      printers: [...this.printers.keys()].map((printerId) => {
        const state = this.health.get(printerId) ?? { health: "UNKNOWN" as const };
        return { printerId, health: state.health, ...(state.detail ? { detail: state.detail.slice(0, 120) } : {}) };
      }),
    });
    this.applyIntervals(reply);
  }

  async refreshConfig(): Promise<void> {
    const config = await this.deps.api.config();
    this.printers.clear();
    for (const printer of config.printers) this.printers.set(printer.printerId, printer);
    for (const printerId of [...this.health.keys()]) if (!this.printers.has(printerId)) this.health.delete(printerId);
    this.applyIntervals(config);
  }

  private applyIntervals(values: { pollIntervalMs: number; heartbeatIntervalMs: number }): void {
    this.pollIntervalMs = clamp(values.pollIntervalMs, 1_000, 60_000);
    this.heartbeatIntervalMs = clamp(values.heartbeatIntervalMs, 5_000, 300_000);
  }

  private async probe(printer: AgentPrinter): Promise<void> {
    try {
      await this.deps.transportFor(printer).probe();
      this.health.set(printer.printerId, { health: "ONLINE" });
    } catch (error) {
      this.health.set(printer.printerId, healthFromError(error));
    }
  }

  /**
   * An admin asked this agent to look for printers (ADR-015). The scan only observes; the one report says what was
   * seen. A failed scan is reported as FAILED with a code, never as "nothing found".
   */
  async runDiscovery(discoveryId: string): Promise<void> {
    const { logger, api } = this.deps;
    if (!api.reportDiscovery) return;
    logger.info("discovery.started", { discoveryId });
    let report: Parameters<NonNullable<AgentApiLike["reportDiscovery"]>>[1];
    try {
      const printers = await (this.deps.discover ?? discoverPrinters)();
      report = { outcome: "COMPLETED", printers };
    } catch (error) {
      const code = error instanceof Error && error.message === "NO_PRIVATE_NETWORK" ? "NO_PRIVATE_NETWORK" : "DISCOVERY_FAILED";
      report = { outcome: "FAILED", errorCode: code, printers: [] };
    }
    try {
      await api.reportDiscovery(discoveryId, report);
      logger.info("discovery.reported", { discoveryId, outcome: report.outcome, found: report.printers.length });
    } catch (error) {
      if (error instanceof AgentApiError && error.kind === "AUTH") throw new FatalAgentError("The server rejected this agent's token (revoked or replaced). Pair the agent again.");
      logger.warn("discovery.report_failed", { discoveryId, kind: error instanceof AgentApiError ? error.kind : "UNKNOWN" });
    }
  }

  /**
   * "Test connection" from the console (printing audit 2026-10-08 P0): open a TCP connection to the printer and close
   * it — the same probe the heartbeat uses — and report the outcome. Never prints, never creates a job.
   */
  async runChecks(checks: readonly PrinterCheckRequest[]): Promise<void> {
    const { api, logger } = this.deps;
    if (!api.reportCheck) return;
    for (const check of checks) {
      let printer = this.printers.get(check.printerId);
      if (!printer) {
        await this.refreshConfig().catch(() => undefined);
        printer = this.printers.get(check.printerId);
      }
      const started = this.now();
      let report: Parameters<NonNullable<AgentApiLike["reportCheck"]>>[1];
      if (!printer) {
        report = { ok: false, errorCode: "PRINTER_NOT_FOUND", detail: "This printer is not assigned to this agent.", elapsedMs: 0 };
      } else {
        try {
          await this.deps.transportFor(printer).probe();
          this.health.set(printer.printerId, { health: "ONLINE" });
          report = { ok: true, elapsedMs: Math.max(0, this.now() - started) };
        } catch (error) {
          const state = healthFromError(error);
          this.health.set(printer.printerId, state);
          report = {
            ok: false,
            errorCode: error instanceof PrintTransportError ? error.code : "PRINT_FAILED",
            detail: (state.detail ?? "Connection test failed").slice(0, 200),
            elapsedMs: Math.max(0, this.now() - started),
          };
        }
      }
      try {
        await api.reportCheck(check.checkId, report);
        logger.info("printer.check_reported", { checkId: check.checkId, printerId: check.printerId, ok: report.ok, code: report.errorCode ?? null });
      } catch (error) {
        if (error instanceof AgentApiError && error.kind === "AUTH") throw new FatalAgentError("The server rejected this agent's token (revoked or replaced). Pair the agent again.");
        logger.warn("printer.check_report_failed", { checkId: check.checkId, kind: error instanceof AgentApiError ? error.kind : "UNKNOWN" });
      }
    }
  }

  async process(job: ClaimedJob): Promise<void> {
    const { logger, journal } = this.deps;
    const ctx = { jobId: job.jobId, printerId: job.printerId, jobType: job.jobType, attempt: job.attemptCount };

    if (journal.has(job.jobId)) {
      // Printed before a crash or a lost acknowledgement: confirm it, do not print a second ticket (TC-AGENT-008).
      logger.info("job.already_printed", ctx);
      await this.acknowledge(job, { result: "PRINTED" });
      return;
    }

    let printer = this.printers.get(job.printerId);
    if (!printer) {
      await this.refreshConfig().catch(() => undefined);
      printer = this.printers.get(job.printerId);
    }
    if (!printer) {
      logger.error("job.unknown_printer", ctx);
      await this.acknowledge(job, { result: "FAILED", errorCode: "PRINTER_NOT_FOUND", errorMessage: "This printer is not assigned to this agent." });
      return;
    }

    let bytes: Buffer;
    try {
      // Encoded for this printer's capability profile (cut type, code page, QR/barcode support).
      bytes = encodeDocument(parsePrintDocument(job.payload), { profile: profileOf(printer.profile) });
    } catch {
      logger.error("job.invalid_payload", ctx);
      await this.acknowledge(job, { result: "FAILED", errorCode: "ESC_POS_RENDER_FAILED", errorMessage: "The agent could not turn this ticket into printer commands." });
      return;
    }

    try {
      await this.deps.transportFor(printer).send(bytes);
    } catch (error) {
      const state = healthFromError(error);
      this.health.set(printer.printerId, state);
      const code = error instanceof PrintTransportError ? error.code : "PRINT_SEND_FAILED";
      logger.warn("job.print_failed", { ...ctx, code });
      await this.acknowledge(job, { result: "FAILED", errorCode: code, errorMessage: (state.detail ?? "Printing failed").slice(0, 500) });
      return;
    }

    try {
      await journal.record(job.jobId);
    } catch {
      // The ticket is on paper; still acknowledge it. Only a crash before the ack could now cause a duplicate.
      logger.error("journal.write_failed", ctx);
    }
    this.health.set(printer.printerId, { health: "ONLINE" });
    logger.info("job.printed", { ...ctx, bytes: bytes.length });
    await this.acknowledge(job, { result: "PRINTED" });
  }

  /**
   * Acknowledges with a few quick retries. If it still cannot get through, the lease expires, the job is re-claimed and
   * the journal turns that into a plain acknowledgement. 409 means the lease was lost to another claim — nothing to do.
   */
  private async acknowledge(job: ClaimedJob, result: Omit<AckBody, "claimToken">): Promise<void> {
    for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt++) {
      try {
        const reply = await this.deps.api.ack(job.jobId, { claimToken: job.claimToken, ...result });
        this.deps.logger.info("job.acknowledged", { jobId: job.jobId, result: result.result, status: reply.status });
        return;
      } catch (error) {
        if (error instanceof AgentApiError) {
          if (error.kind === "AUTH") throw new FatalAgentError("The server rejected this agent's token (revoked or replaced). Pair the agent again.");
          if (error.kind === "CONFLICT" || error.kind === "NOT_FOUND" || error.kind === "REJECTED") {
            this.deps.logger.warn("job.ack_rejected", { jobId: job.jobId, kind: error.kind, code: error.code });
            return;
          }
        }
        if (attempt === ACK_ATTEMPTS) {
          this.deps.logger.error("job.ack_failed", { jobId: job.jobId, result: result.result });
          return;
        }
        await this.sleep(1_000 * 2 ** (attempt - 1));
      }
    }
  }
}

function healthFromError(error: unknown): Health {
  if (error instanceof PrintTransportError) {
    const health: PrinterHealthValue = UNREACHABLE_CODES.has(error.code) ? "OFFLINE" : "ERROR";
    return { health, detail: error.message.slice(0, 120) };
  }
  return { health: "ERROR", detail: "Unexpected printer error" };
}
