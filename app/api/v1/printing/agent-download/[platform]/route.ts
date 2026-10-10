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
 * Serves the print agent package the pairing dialog tells people to install:
 * - Windows: FlowDineOS-Print-Agent-Setup.exe (self-contained installer with service host, no Node.js needed)
 * - Linux: flowdineos-print-agent-linux.tar.gz (hardened systemd service package)
 *
 * Requires an authenticated tenant session with print_agent:manage.
 */

type PackageConfig = {
  file: string;
  type: string;
  candidates: (root: string) => string[];
};

const PACKAGES: Record<"windows" | "linux", PackageConfig> = {
  windows: {
    file: "FlowDineOS-Print-Agent-Setup.exe",
    type: "application/vnd.microsoft.portable-executable",
    candidates: (root: string) => [
      path.join(root, "print-agent", "dist", "windows", "FlowDineOS-Print-Agent-Setup.exe"),
      path.join(root, "print-agent", "packaging", "windows", "bin", "FlowDineOS-Print-Agent-Setup.exe"),
      path.join(root, "public", "downloads", "FlowDineOS-Print-Agent-Setup.exe"),
    ],
  },
  linux: {
    file: "flowdineos-print-agent-linux.tar.gz",
    type: "application/gzip",
    candidates: (root: string) => [
      path.join(root, "print-agent", "dist", "flowdineos-print-agent-linux.tar.gz"),
      path.join(root, "print-agent", "dist", "rasoios-print-agent-linux.tar.gz"),
    ],
  },
} as const;

type Platform = keyof typeof PACKAGES;
const isPlatform = (value: string): value is Platform => Object.hasOwn(PACKAGES, value);

// `Record<string, string>` rather than `{ platform: string }`: Next.js accepts it (the narrower shape is assignable
// to it), and it matches the shared `invokeRoute` test harness, so the route needs no cast to be tested.
export const GET = route(async (_request, { params }: { params: Promise<Record<string, string>> }) => {
  const ctx = await requireTenant("print_agent:manage");
  const { platform } = await params;
  if (!isPlatform(platform)) throw new NotFoundError("That print agent package does not exist.");

  const pkg = PACKAGES[platform];
  const root = process.cwd();
  const candidateFiles = pkg.candidates(root);

  let bytes: Buffer | null = null;

  for (const file of candidateFiles) {
    try {
      await stat(file);
      bytes = await readFile(file);
      break;
    } catch {
      // try next candidate
    }
  }

  // Optional remote fallback for Windows installer if not present in local deployment
  if (!bytes && platform === "windows" && process.env.FLOWDINEOS_PRINT_AGENT_SETUP_URL) {
    try {
      const res = await fetch(process.env.FLOWDINEOS_PRINT_AGENT_SETUP_URL);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        bytes = Buffer.from(arrayBuf);
      }
    } catch (error) {
      logger.error("print_agent.remote_fetch_failed", { requestId: ctx.requestId, error: (error as Error).message });
    }
  }

  if (!bytes) {
    logger.error("print_agent.package_missing", { requestId: ctx.requestId, platform, tried: candidateFiles });
    throw new NotFoundError(
      platform === "windows"
        ? "The FlowDineOS Print Agent Windows installer (FlowDineOS-Print-Agent-Setup.exe) was not found in this deployment. Please verify the build or contact support."
        : "The FlowDineOS Print Agent Linux package was not built into this deployment. Ask your administrator to redeploy FlowDineOS.",
    );
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": pkg.type,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${pkg.file}"`,
      "x-package-sha256": createHash("sha256").update(bytes).digest("hex"),
      "cache-control": "no-store",
    },
  });
});
