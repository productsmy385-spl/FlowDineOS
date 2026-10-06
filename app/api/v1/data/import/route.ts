import type { NextRequest } from "next/server";
import { requireTenant } from "@/lib/auth/guards";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { readCappedForm } from "@/lib/http/capped-form";
import { route } from "@/lib/http/route";
import { assertSameOrigin } from "@/lib/http/same-origin";
import { consumeScope } from "@/lib/security/rate-limit";
import { commitImport, previewImport } from "@/lib/services/data-management";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_BACKUP_BYTES = 60 * 1024 * 1024;

const fileError = (message: string) => new ValidationError(message, { file: [message] }, "IMPORT_INVALID");

/**
 * RH-DATA-02 — `POST /api/v1/data/import` (`data:import`, RASOIOS-ADR-021).
 *
 * multipart/form-data with `file` and `mode` = `preview` | `commit`. Preview validates and counts without writing;
 * commit validates the same file again and adds only the missing records, in one transaction. The restaurant is the
 * session's; a backup from another restaurant is refused.
 */
export const POST = route(async (request: NextRequest) => {
  const ctx = await requireTenant("data:import");
  assertSameOrigin(request, ctx.requestId);

  const limit = await consumeScope("data.import", ctx.userId);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSec, "Too many imports. Try again later.");

  const form = await readCappedForm(request, MAX_BACKUP_BYTES + 64 * 1024, {
    tooLarge: () => fileError("The file is larger than 60 MB. Export a shorter date range and import that."),
    invalid: (reason) => fileError(reason === "unreadable" ? "The upload could not be read. Try again." : "Choose a backup file."),
  });
  const mode = form.get("mode");
  const file = form.get("file");
  if (mode !== "preview" && mode !== "commit") throw fileError("Choose preview or import.");
  if (!(file instanceof File) || file.size === 0) throw fileError("Choose a backup file.");

  const input = { name: file.name.slice(0, 200), bytes: Buffer.from(await file.arrayBuffer()) };
  const data = mode === "preview" ? await previewImport(ctx, input) : await commitImport(ctx, input);
  return Response.json(data, { headers: { "x-request-id": ctx.requestId, "cache-control": "no-store" } });
});
