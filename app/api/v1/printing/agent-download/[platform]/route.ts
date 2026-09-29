import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { requireTenant } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/errors";
import { route } from "@/lib/http/route";
import { logger } from "@/lib/logger";

/**
 * RH-PRINT-08 — `GET /api/v1/printing/agent-download/{platform}` (S1-P17-T009).
 *
 * Serves the print agent package the pairing dialog tells people to install. Until this existed the dialog said to
 * "unzip the RASOIOS print agent download" and there was nothing to download: `npm run agent:build` produced the
 * bundle, but nothing packaged it for a restaurant or handed it over.
 *
 * The packages are built during deployment (`railway.json` runs `agent:build`), so what a restaurant installs is
 * always the same build as the server it pairs with.
 *
 * Deliberately *not* under `/api/v1/print-agent/…`: that prefix is the agent's own bearer-token API (ADR-007), and a
 * route there would skip the Clerk gate entirely. This is a console download, so it takes a console session and the
 * permission that manages agents. The file is identical for every tenant — it holds no tenant data, and pairing is
 * what binds an installed agent to one restaurant — but it is still not public: handing the agent binary to anyone
 * who asks widens the attack surface for nothing.
 */

const PACKAGES = {
  windows: { file: "rasoios-print-agent-windows.zip", type: "application/zip" },
  linux: { file: "rasoios-print-agent-linux.tar.gz", type: "application/gzip" },
} as const;

type Platform = keyof typeof PACKAGES;
const isPlatform = (value: string): value is Platform => Object.hasOwn(PACKAGES, value);

export const GET = route(async (_request, { params }: { params: Promise<{ platform: string }> }) => {
  const ctx = await requireTenant("print_agent:manage");
  const { platform } = await params;
  if (!isPlatform(platform)) throw new NotFoundError("That print agent package does not exist.");

  const pkg = PACKAGES[platform];
  // `process.cwd()` is the repository root under both `next dev` and `next start`, which is where `agent:build` writes.
  const file = path.join(process.cwd(), "print-agent", "dist", pkg.file);

  let bytes: Buffer;
  try {
    await stat(file);
    bytes = await readFile(file);
  } catch {
    // The package was not built into this deployment. Say so plainly rather than serving an empty or placeholder
    // file: an installer that verifies a truncated bundle against SHA256SUMS would fail confusingly on the
    // restaurant's PC, long after the real mistake was made here.
    logger.error("print_agent.package_missing", { requestId: ctx.requestId, platform, file });
    throw new NotFoundError("The print agent package was not built into this deployment. Ask your administrator to redeploy RASOIOS.");
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": pkg.type,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${pkg.file}"`,
      // The installer checks the bundle against SHA256SUMS inside the package; this lets someone check the package
      // itself against what the console shows before they run anything as Administrator.
      "x-package-sha256": createHash("sha256").update(bytes).digest("hex"),
      // Never cached: a redeploy changes these bytes, and an agent must not be older than the server that pairs it.
      "cache-control": "no-store",
    },
  });
});
