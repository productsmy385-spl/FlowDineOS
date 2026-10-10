import { z } from "zod";

/**
 * Client of the machine API RH-AGT-01…05 (ADR-007, api.md §Print Agent).
 *
 * - Every response is validated: the agent treats the server's answer as untrusted input, like any other network data.
 * - `redirect: "error"`: a redirect could carry the bearer header to another origin, so none is followed.
 * - Every call has a timeout; a hung connection must not stall the claim loop.
 * - No request body carries a tenant — the server derives it from the token (ADR-007 §1).
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ApiErrorKind = "AUTH" | "INVALID_PAIRING_CODE" | "RATE_LIMITED" | "CONFLICT" | "NOT_FOUND" | "REJECTED" | "SERVER" | "NETWORK" | "PROTOCOL";

export class AgentApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export type PrinterHealthValue = "UNKNOWN" | "ONLINE" | "OFFLINE" | "ERROR";

export const agentPrinterSchema = z.object({
  printerId: z.string().uuid(),
  name: z.string().max(120),
  purpose: z.enum(["KOT", "RECEIPT", "KOT_AND_RECEIPT"]),
  connectionType: z.enum(["LAN", "USB"]),
  connectionAddress: z.string().max(255),
  paperWidthMm: z.number().int(),
  /** Capability profile key (lib/print/profiles.ts); absent from servers older than 2026-10-08. */
  profile: z.string().max(40).optional(),
});
export type AgentPrinter = z.infer<typeof agentPrinterSchema>;

const intervals = { pollIntervalMs: z.number().int().positive(), heartbeatIntervalMs: z.number().int().positive() };
const pairResponseSchema = z.object({ agentId: z.string().uuid(), token: z.string().min(20).max(200), printers: z.array(agentPrinterSchema), ...intervals });
const configResponseSchema = z.object({ agentId: z.string().uuid(), printers: z.array(agentPrinterSchema).max(50), ...intervals });
const heartbeatResponseSchema = z.object({ serverTime: z.string(), ...intervals });
export const claimedJobSchema = z.object({
  jobId: z.string().uuid(),
  claimToken: z.string().uuid(),
  printerId: z.string().uuid(),
  jobType: z.enum(["KOT", "RECEIPT", "TEST"]),
  payload: z.unknown(),
  leaseExpiresAt: z.string(),
  attemptCount: z.number().int(),
});
export type ClaimedJob = z.infer<typeof claimedJobSchema>;
/** `discovery` is set when an admin asked this agent to scan its LAN for printers (RASOIOS-ADR-015). */
/** A console "Test connection" of one printer (2026-10-08): connect and close, never print. */
export const printerCheckRequestSchema = z.object({ checkId: z.string().uuid(), printerId: z.string().uuid() });
export type PrinterCheckRequest = z.infer<typeof printerCheckRequestSchema>;
const claimResponseSchema = z.object({
  jobs: z.array(claimedJobSchema).max(10),
  discovery: z.object({ discoveryId: z.string().uuid() }).nullable().optional(),
  checks: z.array(printerCheckRequestSchema).max(10).optional(),
});
export type PrinterCheckReport = { ok: boolean; errorCode?: string; detail?: string; elapsedMs: number };
const checkReportResponseSchema = z.object({ checkId: z.string().uuid(), status: z.string() });
const discoveryReportResponseSchema = z.object({ discoveryId: z.string().uuid(), status: z.enum(["COMPLETED", "FAILED"]) });

export type DiscoveredDevice = {
  address: string;
  port: number;
  protocol: "RAW_9100" | "IPP";
  rawPrinting: boolean;
  name?: string;
  manufacturer?: string;
  model?: string;
  sources: Array<"MDNS" | "PORT_PROBE">;
};
export type DiscoveryReport = { outcome: "COMPLETED" | "FAILED"; errorCode?: string; printers: DiscoveredDevice[] };
const ackResponseSchema = z.object({ jobId: z.string().uuid(), status: z.string() });

export type PairResponse = z.infer<typeof pairResponseSchema>;
export type ConfigResponse = z.infer<typeof configResponseSchema>;
export type HeartbeatBody = { agentVersion?: string; printers: Array<{ printerId: string; health: PrinterHealthValue; detail?: string }> };
export type AckBody = { claimToken: string; result: "PRINTED" | "FAILED"; errorCode?: string; errorMessage?: string };

export interface AgentApiLike {
  config(): Promise<ConfigResponse>;
  heartbeat(body: HeartbeatBody): Promise<z.infer<typeof heartbeatResponseSchema>>;
  claim(max: number): Promise<{ jobs: ClaimedJob[]; discovery?: { discoveryId: string } | null; checks?: PrinterCheckRequest[] }>;
  reportCheck?(checkId: string, report: PrinterCheckReport): Promise<{ checkId: string; status: string }>;
  reportDiscovery?(discoveryId: string, report: DiscoveryReport): Promise<{ discoveryId: string; status: string }>;
  ack(jobId: string, body: AckBody): Promise<{ jobId: string; status: string }>;
}

export class AgentApi implements AgentApiLike {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(
    private readonly origin: string,
    private readonly token: string | null,
    options: { fetch?: FetchLike; timeoutMs?: number; userAgent?: string } = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent ?? "flowdineos-print-agent";
  }

  static async pair(origin: string, body: { pairingCode: string; agentVersion: string; osInfo: string }, options: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<PairResponse> {
    const api = new AgentApi(origin, null, options);
    return api.request("POST", "/api/v1/print-agent/pair", body, pairResponseSchema);
  }

  config() {
    return this.request("GET", "/api/v1/print-agent/config", undefined, configResponseSchema);
  }

  heartbeat(body: HeartbeatBody) {
    return this.request("POST", "/api/v1/print-agent/heartbeat", body, heartbeatResponseSchema);
  }

  claim(max: number) {
    return this.request("POST", "/api/v1/print-agent/jobs/claim", { max }, claimResponseSchema);
  }

  reportDiscovery(discoveryId: string, report: DiscoveryReport) {
    if (!z.string().uuid().safeParse(discoveryId).success) throw new AgentApiError("PROTOCOL", "Refusing to report on an id that is not a UUID");
    return this.request("POST", `/api/v1/print-agent/discoveries/${discoveryId}`, report, discoveryReportResponseSchema);
  }

  reportCheck(checkId: string, report: PrinterCheckReport) {
    if (!z.string().uuid().safeParse(checkId).success) throw new AgentApiError("PROTOCOL", "Refusing to report on an id that is not a UUID");
    return this.request("POST", `/api/v1/print-agent/checks/${checkId}`, report, checkReportResponseSchema);
  }

  ack(jobId: string, body: AckBody) {
    if (!z.string().uuid().safeParse(jobId).success) throw new AgentApiError("PROTOCOL", "Refusing to acknowledge a job id that is not a UUID");
    return this.request("POST", `/api/v1/print-agent/jobs/${jobId}/ack`, body, ackResponseSchema);
  }

  private async request<T extends z.ZodTypeAny>(method: "GET" | "POST", path: string, body: unknown, schema: T): Promise<z.output<T>> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": this.userAgent };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin).toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError";
      throw new AgentApiError("NETWORK", timedOut ? "The server did not answer in time" : "Could not reach the server");
    }

    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) throw toApiError(response, json);

    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AgentApiError("PROTOCOL", `Unexpected response from ${path}`, response.status);
    return parsed.data;
  }
}

function toApiError(response: Response, json: unknown): AgentApiError {
  const status = response.status;
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message.slice(0, 200) : `HTTP ${status}`;
  if (status === 401 && code === "INVALID_PAIRING_CODE") return new AgentApiError("INVALID_PAIRING_CODE", message, status, code);
  if (status === 401) {
    if (code === "INVALID_AGENT_TOKEN" || code === "REVOKED_AGENT_TOKEN" || code === "UNAUTHENTICATED") {
      return new AgentApiError("AUTH", message, status, code);
    }
    return new AgentApiError("NETWORK", `Unauthenticated gateway or proxy (HTTP 401): ${message}`, status, code);
  }
  if (status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return new AgentApiError("RATE_LIMITED", message, status, code, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000);
  }
  if (status === 409) return new AgentApiError("CONFLICT", message, status, code);
  if (status === 404) return new AgentApiError("NOT_FOUND", message, status, code);
  if (status >= 400 && status < 500) return new AgentApiError("REJECTED", message, status, code);
  return new AgentApiError("SERVER", message, status, code);
}
