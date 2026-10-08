import type { NextRequest } from "next/server";
import { requireAgent } from "@/lib/auth/agent";
import { route } from "@/lib/http/route";
import { reportPrinterCheck } from "@/lib/services/printing";
import { parseInput } from "@/lib/validation/core";
import { agentCheckReportSchema, printerCheckIdSchema } from "@/lib/validation/printing";
import { agentApiRateLimit, readAgentJson } from "../../agent-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RH-AGT-07 — `POST /api/v1/print-agent/checks/{checkId}` (printing audit 2026-10-08, "Test connection").
 *
 * The agent's result of one connection test it picked up from its claim response: it opened and closed a TCP
 * connection to its own printer. Accepted only for a RUNNING check of the calling agent in the calling agent's tenant
 * (both from the bearer token); anything else is 409. The cloud never connects to the printer itself.
 */
export const POST = route<{ params: Promise<{ checkId: string }> }>(async (request: NextRequest, context) => {
  const ctx = await requireAgent(request);
  const limited = await agentApiRateLimit(ctx);
  if (limited) return limited;

  const { checkId } = parseInput(printerCheckIdSchema, await context.params);
  const report = await readAgentJson(request, agentCheckReportSchema);
  return reportPrinterCheck(ctx, checkId, {
    ok: report.ok,
    elapsedMs: report.elapsedMs,
    ...(report.errorCode ? { errorCode: report.errorCode } : {}),
    detail: report.detail ?? null,
  });
});
