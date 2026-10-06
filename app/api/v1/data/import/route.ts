import type { NextRequest } from "next/server";
import { requirePermission, requireTenant } from "@/lib/auth/guards";
import { restaurantCountry } from "@/lib/data/simple-import";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { readCappedForm } from "@/lib/http/capped-form";
import { route } from "@/lib/http/route";
import { assertSameOrigin } from "@/lib/http/same-origin";
import { consumeScope } from "@/lib/security/rate-limit";
import { commitImport, previewImport } from "@/lib/services/data-management";
import { commitSimpleImport, previewSimpleImport } from "@/lib/services/simple-import";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_BACKUP_BYTES = 60 * 1024 * 1024;

const fileError = (message: string) => new ValidationError(message, { file: [message] }, "IMPORT_INVALID");

/**
 * RH-DATA-02 — `POST /api/v1/data/import` (`data:import`, RASOIOS-ADR-021).
 *
 * multipart/form-data with `file`, `mode` = `preview` | `commit` and `kind` = `backup` (default) | `customers` |
 * `menuItems` (a plain CSV/Excel list, RASOIOS-ADR-022). Preview validates and counts without writing;
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
  const kind = form.get("kind") ?? "backup";
  const file = form.get("file");
  if (mode !== "preview" && mode !== "commit") throw fileError("Choose preview or import.");
  if (kind !== "backup" && kind !== "customers" && kind !== "menuItems") throw fileError("Choose what the file contains.");
  if (!(file instanceof File) || file.size === 0) throw fileError("Choose a file.");

  const input = { name: file.name.slice(0, 200), bytes: Buffer.from(await file.arrayBuffer()) };
  let data: unknown;
  if (kind === "backup") {
    data = mode === "preview" ? await previewImport(ctx, input) : await commitImport(ctx, input);
  } else {
    // A spreadsheet of customers or dishes goes through the console's own create services, so it needs their rights too.
    requirePermission(ctx, kind === "customers" ? "customer:create" : "menu:manage");
    const country = await restaurantCountry(ctx);
    data = mode === "preview" ? await previewSimpleImport(ctx, kind, input, country) : await commitSimpleImport(ctx, kind, input, country);
  }
  return Response.json(data, { headers: { "x-request-id": ctx.requestId, "cache-control": "no-store" } });
});
