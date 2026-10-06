import type { NextRequest } from "next/server";
import { requireTenant } from "@/lib/auth/guards";
import { ForbiddenError, RateLimitedError } from "@/lib/errors";
import { route } from "@/lib/http/route";
import { consumeScope } from "@/lib/security/rate-limit";
import { buildExport } from "@/lib/services/data-management";
import { parseInput } from "@/lib/validation/core";
import { exportQuerySchema } from "@/lib/validation/data";

export const dynamic = "force-dynamic";
// A full backup of a busy restaurant takes a while to read and compress.
export const maxDuration = 120;

/**
 * RH-DATA-01 — `GET /api/v1/data/export?datasets=&format=&from=&to=&backupId=` (`data:export`, RASOIOS-ADR-021).
 *
 * Streams a backup of the session's own restaurant as a download. A GET, so the browser can save it straight to disk,
 * but only from this app's own pages: a cross-site request (Sec-Fetch-Site other than same-origin or none) is refused,
 * so another site cannot make an admin's browser produce exports. Each export leaves a `data.exported` audit record;
 * `x-backup-id` names it, which is what a later deletion quotes.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireTenant("data:export");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new ForbiddenError("Start the download from the Data screen.");

  const limit = await consumeScope("data.export", ctx.userId);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSec, "Too many exports. Try again later.");

  const query = parseInput(exportQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
  const file = await buildExport(ctx, query);
  return new Response(new Uint8Array(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.filename}"`,
      "content-length": String(file.body.length),
      "cache-control": "no-store",
      "x-backup-id": file.backupId,
      "x-request-id": ctx.requestId,
    },
  });
});
