import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { clientIpFrom } from "@/lib/http/client-ip";
import { logger } from "@/lib/logger";
import { findAgentByTokenHash, printerIdsOfAgent, touchAgent } from "@/lib/data/printing";
import { now } from "@/lib/time/clock";
import type { AgentContext } from "./context-types";

/**
 * Print-agent authentication (S1-P16-T005, ADR-007 §1, SC-PRINT-01, SC-PRINT-09, SC-TEN-07).
 *
 * Every agent call but pairing carries `Authorization: Bearer <token>`. The server hashes the token with SHA-256 —
 * the token is 256 bits of CSPRNG output, so a slow KDF buys nothing — looks up an **ACTIVE** `PRINT_AGENT` by that
 * hash, and takes the tenant *from that row*. There is no tenant field in any agent request; a request that carries
 * one is 422 (the schemas are strict).
 *
 * Fail closed: a missing header, a malformed header, an unknown hash, a revoked agent (its hash is cleared on
 * revocation) and a database error all produce `401 INVALID_AGENT_TOKEN` with the same body, so the endpoint is not
 * an oracle for which tokens exist. Tokens are never logged — `lib/logger.ts` redacts `authorization`, any key
 * containing "token", and `rsa_…` strings anywhere in a message.
 */

/** Token shape: `rsa_` + 32 random bytes, base64url. The prefix is what `lib/logger.ts` scrubs. */
export const AGENT_TOKEN_PREFIX = "rsa_";
export const AGENT_TOKEN_BYTES = 32;

/** 401 for every agent-authentication failure, with one message. */
export class InvalidAgentTokenError extends AppError {
  constructor(message = "Invalid or revoked agent token.") {
    super(message, 401, "INVALID_AGENT_TOKEN");
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests (used for pairing-code checks that are not index lookups). */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type IssuedAgentToken = { token: string; tokenHash: string; tokenPrefix: string };

/** Mints a token. The plaintext is returned once to the caller and never stored (ADR-007 §1). */
export function issueAgentToken(): IssuedAgentToken {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(AGENT_TOKEN_BYTES).toString("base64url")}`;
  return { token, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 8) };
}

const BEARER = /^Bearer\s+(\S+)$/i;
/** Long enough that a truncated or guessed value never reaches the database. */
const MIN_TOKEN_LENGTH = AGENT_TOKEN_PREFIX.length + 16;

export function bearerTokenOf(request: { headers: Headers }): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = BEARER.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length < MIN_TOKEN_LENGTH || token.length > 200) return null;
  return token;
}

/**
 * The source address for `last_seen_ip` and for the pairing rate limit, or `null` when the deployment cannot prove
 * one (`lib/http/client-ip.ts`, SC-LOG-01).
 *
 * It is deliberately not the left-most `X-Forwarded-For` entry: that entry is written by the caller, so keying the
 * brute-force limit on it would let an attacker mint a fresh bucket per attempt and defeat the very control that
 * protects pairing (T-015, ADV-015). Only the entry our own proxies added counts.
 */
export function agentSourceIp(request: { headers: Headers }): string | null {
  return clientIpFrom(request.headers.get("x-forwarded-for"));
}

/**
 * Rate-limit identity for `agent.pair`: the address our proxies observed, or one shared bucket when there is none.
 * Sharing is the honest choice — if callers cannot be told apart, they have to be limited as one caller.
 */
export function pairRateLimitKey(request: { headers: Headers }): string {
  return agentSourceIp(request) ?? "unknown-source";
}

/** `last_seen_at` is refreshed at most this often, so a 3 s claim poll does not write on every request (ADR-007 §7). */
export const LAST_SEEN_THROTTLE_MS = 20_000;

/**
 * Resolves the calling agent, or throws `InvalidAgentTokenError`. Route handlers call this first — the static guard
 * `tests/static/guard-coverage.test.ts` accepts it as an entry guard alongside the session guards.
 */
export async function requireAgent(request: { headers: Headers }): Promise<AgentContext> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const token = bearerTokenOf(request);
  if (!token) {
    logger.warn("security.agent_unauthenticated", { requestId, reason: "missing_or_malformed_bearer" });
    throw new InvalidAgentTokenError();
  }

  let agent;
  try {
    agent = await findAgentByTokenHash(sha256Hex(token));
  } catch (error) {
    // Fail closed: an unreachable database must not let an unauthenticated caller through,
    // but must fail as a server error (500/503), NEVER a 401 invalid token error.
    logger.error("security.agent_lookup_failed", { requestId, error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  if (!agent) {
    logger.warn("security.agent_unauthenticated", { requestId, reason: "unknown_or_revoked" });
    throw new InvalidAgentTokenError();
  }

  const ctx: AgentContext = {
    kind: "agent",
    requestId,
    agentId: agent.id,
    tenantId: agent.tenantId,
    printerIds: await printerIdsOfAgent(agent.tenantId, agent.id),
  };

  const at = now();
  if (!agent.lastSeenAt || at.getTime() - agent.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
    // Liveness is telemetry: a failed update must never fail the request it rode in on.
    await touchAgent(ctx, at, { ip: agentSourceIp(request) }).catch((error: unknown) =>
      logger.warn("print_agent.last_seen_update_failed", { requestId, error: String(error) }),
    );
  }
  return ctx;
}
