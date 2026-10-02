import "server-only";
import { createHash } from "node:crypto";
import { deleteExpiredBuckets, hitBucket } from "@/lib/data/rate-limit";
import { mapDatabaseError } from "@/lib/data/errors";
import { ServiceUnavailableError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { now as clockNow } from "@/lib/time/clock";

/**
 * Fixed-window rate limiter on PostgreSQL (ADR-011, S1-P03-T007, SC-RL-01/02). No extra infrastructure.
 *
 * `consume(scope, identifier)` counts one hit and says whether it is allowed. The identifier (IP, user id, agent id)
 * is hashed before it reaches the database. When the database cannot be reached, a scope either fails open (allow,
 * log a warning) or fails closed (503), as configured per scope.
 */

export type RateLimitPolicy = { limit: number; windowSec: number; failOpen: boolean };

/** Initial limits from ADR-011 §2 (tuned by the load test in S1-P28). */
export const RATE_LIMITS = {
  "agent.pair": { limit: 5, windowSec: 15 * 60, failOpen: false },
  "agent.api": { limit: 120, windowSec: 60, failOpen: false },
  "webhook.clerk": { limit: 60, windowSec: 60, failOpen: false },
  "public.order.submit": { limit: 5, windowSec: 10 * 60, failOpen: false },
  "session.mutation": { limit: 120, windowSec: 60, failOpen: true },
  // Image uploads (ADR-017 §8, api.md RH-MEDIA-01): per user; each one costs re-encoding CPU and ImageKit storage.
  "media.upload": { limit: 30, windowSec: 60 * 60, failOpen: false },
  // Staff daily-password sign-in (ADR-019 §5). Two buckets: one per email so a colleague's typos cannot lock a
  // person out, one per address so a spray across many emails from one machine is still stopped. Fail closed —
  // a guessable eight-character password must never fall back to unlimited attempts because the database blinked.
  "staff.login.identifier": { limit: 10, windowSec: 15 * 60, failOpen: false },
  "staff.login.address": { limit: 30, windowSec: 15 * 60, failOpen: false },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitScope = keyof typeof RATE_LIMITS;

export type RateLimitResult = {
  allowed: boolean;
  scope: string;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends (for Retry-After). */
  retryAfterSec: number;
  resetAt: Date;
};

export function bucketKey(scope: string, identifier: string): string {
  return `${scope}:${createHash("sha256").update(identifier, "utf8").digest("hex")}`;
}

export async function consume(
  scope: string,
  identifier: string,
  policy: RateLimitPolicy,
  options: { now?: Date; cleanupProbability?: number } = {},
): Promise<RateLimitResult> {
  const at = options.now ?? clockNow();
  const windowMs = policy.windowSec * 1000;
  const windowStart = new Date(Math.floor(at.getTime() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - at.getTime()) / 1000));

  let hitCount: number;
  try {
    ({ hitCount } = await hitBucket(bucketKey(scope, identifier), windowStart, resetAt));
  } catch (error) {
    const mapped = mapDatabaseError(error, "Rate limit");
    if (policy.failOpen) {
      logger.warn("security.rate_limit_unavailable", { scope, failOpen: true });
      return { allowed: true, scope, limit: policy.limit, remaining: policy.limit, retryAfterSec, resetAt };
    }
    logger.error("security.rate_limit_unavailable", { scope, failOpen: false });
    throw mapped instanceof ServiceUnavailableError ? mapped : new ServiceUnavailableError();
  }

  if (Math.random() < (options.cleanupProbability ?? 0.01)) {
    deleteExpiredBuckets(at).catch((error: unknown) => logger.warn("security.rate_limit_cleanup_failed", { error: String(error) }));
  }

  const allowed = hitCount <= policy.limit;
  if (!allowed) logger.warn("security.rate_limited", { scope, limit: policy.limit, windowSec: policy.windowSec });
  return { allowed, scope, limit: policy.limit, remaining: Math.max(0, policy.limit - hitCount), retryAfterSec, resetAt };
}

/** `consume` with the scope's configured policy. */
export function consumeScope(scope: RateLimitScope, identifier: string, options: { now?: Date } = {}): Promise<RateLimitResult> {
  return consume(scope, identifier, RATE_LIMITS[scope], options);
}

/** HTTP 429 for route handlers: `Retry-After` and a generic body that reveals nothing about other buckets. */
export function rateLimitedResponse(result: RateLimitResult, requestId?: string): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly.", ...(requestId ? { requestId } : {}) } },
    {
      status: 429,
      headers: {
        "retry-after": String(result.retryAfterSec),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": "0",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    },
  );
}
