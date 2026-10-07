import type { NextRequest } from "next/server";
import { requireTenant } from "@/lib/auth/guards";
import { zip } from "@/lib/data-portability/zip";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { route } from "@/lib/http/route";
import { getTables } from "@/lib/services/dining-tables";

export const dynamic = "force-dynamic";

const fileStem = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";

/**
 * RH-TBL-01 — `GET /api/v1/tables/qr-codes` (`table:manage`, RASOIOS-ADR-021): every live table's QR code as SVG files
 * in one ZIP, named after the table, for a print shop or a label printer. Only this restaurant's tables; switched-off
 * tables are left out because their codes do not open anything. Same-origin downloads only, like data exports.
 */
export const GET = route(async (request: NextRequest) => {
  const ctx = await requireTenant("table:manage");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new ForbiddenError("Start the download from the Tables screen.");

  const { restaurantName, tables } = await getTables(ctx);
  const live = tables.filter((t) => t.isActive);
  if (live.length === 0) throw new ValidationError("There are no live tables to download.", { tables: ["Add a table or switch one on first."] });

  const used = new Set<string>();
  const files = live.map((table) => {
    let name = fileStem(table.label);
    for (let n = 2; used.has(name); n++) name = `${fileStem(table.label)}-${n}`;
    used.add(name);
    return { name: `${name}.svg`, data: Buffer.from(table.qrSvg, "utf8") };
  });
  const body = zip(files);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fileStem(restaurantName)}-table-qr-codes.zip"`,
      "cache-control": "no-store",
      "x-request-id": ctx.requestId,
    },
  });
});
