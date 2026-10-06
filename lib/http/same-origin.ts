import "server-only";
import type { NextRequest } from "next/server";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { appUrl } from "@/lib/env";

/**
 * SC-CSRF-02 / RASOIOS-ADR-011 §4 — cookie-authenticated, state-changing Route Handlers must prove the request came
 * from this application's own pages. Server Actions get this from Next.js; Route Handlers call `assertSameOrigin`.
 *
 * - `Sec-Fetch-Site`, when the browser sends it, must be `same-origin`.
 * - `Origin` is required and must be this app: its configured URL (NEXT_PUBLIC_APP_URL) or the origin the request was
 *   addressed to. Browsers always send `Origin` on a cross-origin or non-GET fetch, so a missing one is refused.
 */
export function assertSameOrigin(request: NextRequest, requestId: string): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const allowed = new Set([request.nextUrl.origin, configuredOrigin()].filter((value): value is string => value !== null));

  if ((site !== null && site !== "same-origin") || origin === null || !allowed.has(origin)) {
    logger.warn("security.cross_origin_refused", { requestId, site, originPresent: origin !== null });
    throw new ForbiddenError("This request must come from the FlowDineOS console.");
  }
}

function configuredOrigin(): string | null {
  try {
    const configured = appUrl();
    return configured ? new URL(configured).origin : null;
  } catch {
    return null;
  }
}
