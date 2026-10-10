import "server-only";
import { randomUUID } from "node:crypto";
import { PrintJobStatus, PrintJobType, PrinterConnection, PrinterPurpose } from "@prisma/client";
import { audit } from "@/lib/audit/write";
import { issueAgentToken, sha256Hex } from "@/lib/auth/agent";
import type { AgentContext, TenantContext } from "@/lib/auth/context-types";
import {
  ackJob,
  activatePairedAgent,
  claimJobs,
  createPrintJob,
  findPrinterRow,
  insertPrintAgentPairing,
  insertPrinter,
  listPrinters as listPrintersData,
  listPrintAgents,
  listPrintJobs as listPrintJobsData,
  printingProfile,
  touchAgent,
  type PrintAgentDto,
} from "@/lib/data/printing";
import { withTx } from "@/lib/data/tx";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { renderKotDocument } from "@/lib/print/render-kot";
import { profileOf } from "@/lib/print/profiles";
import { getVirtualPrinterAdapter, isVirtualAddress, type VirtualPrinterSimulationMode, type VirtualPrintedTicket, type VirtualPrinterState } from "@/lib/print/virtual-printer";
import { assertVirtualPrintingEnabled } from "@/lib/print/virtual-safety";
import { getAgentPresenceStatus, type AgentPresenceStatus } from "@/lib/services/printing";
import { now } from "@/lib/time/clock";
import { encodeDocument } from "@/print-agent/src/escpos";
import { parsePrintDocument } from "@/lib/print/types";

export type VirtualEnvironmentSummary = {
  isVirtualEnabled: boolean;
  agent: {
    id: string;
    name: string;
    status: AgentPresenceStatus;
    lastSeenAt: string | null;
    version: string | null;
    tokenPrefix: string | null;
    pairedAt: string | null;
  } | null;
  printer: {
    id: string;
    name: string;
    connectionAddress: string;
    paperWidthMm: number;
    profile: string;
    purpose: PrinterPurpose;
    health: string;
  } | null;
  emulatorState: VirtualPrinterState;
  queue: {
    queued: number;
    sending: number;
    retrying: number;
    delivered: number;
    failed: number;
    cancelled: number;
  };
  latestJob: {
    id: string;
    jobType: string;
    status: string;
    orderNumber: string | null;
    kotNumber: string | null;
    createdAt: string;
    printedAt: string | null;
  } | null;
  tickets: VirtualPrintedTicket[];
};

/**
 * Resolves or provisions the tenant's dedicated Virtual Print Agent and Virtual Kitchen Printer.
 */
export async function getOrCreateVirtualEnvironment(ctx: TenantContext): Promise<VirtualEnvironmentSummary> {
  assertVirtualPrintingEnabled();

  const [agents, printers] = await Promise.all([
    listPrintAgents(ctx),
    listPrintersData(ctx),
  ]);

  // Find or provision Virtual Print Agent
  let virtualAgent = agents.find((a) => a.name.includes("Virtual") || a.agentVersion?.includes("virtual"));

  if (!virtualAgent) {
    virtualAgent = await withTx(ctx, async (tx) => {
      const pairing = await insertPrintAgentPairing(tx, ctx, {
        name: "FlowDineOS Virtual Print Agent",
        pairingCodeHash: sha256Hex(`VIRTUAL-${randomUUID()}`),
        pairingExpiresAt: new Date(Date.now() + 86400_000),
        createdByUserId: ctx.userId,
      });

      const { tokenHash, tokenPrefix } = issueAgentToken();
      await activatePairedAgent(
        tx,
        { id: pairing.id, tenantId: ctx.tenantId },
        {
          tokenHash,
          tokenPrefix,
          agentVersion: "0.2.1-virtual",
          osInfo: "FlowDineOS Virtual Agent Emulator",
          at: now(),
          ip: "127.0.0.1",
        },
      );

      await audit(tx, ctx, {
        action: "print_agent.created",
        resourceType: "print_agent",
        resourceId: pairing.id,
        after: { name: pairing.name, status: "ACTIVE", virtual: true },
      });

      const createdDto: PrintAgentDto = {
        id: pairing.id,
        name: pairing.name,
        status: "ACTIVE" as const,
        agentVersion: "0.2.1-virtual",
        osInfo: "FlowDineOS Virtual Agent Emulator",
        lastSeenAt: now().toISOString(),
        tokenPrefix,
        pairedAt: now().toISOString(),
        pairingExpiresAt: null,
        revokedAt: null,
      };

      return createdDto;
    });
  } else if (virtualAgent.status === "ACTIVE") {
    await touchAgent(
      {
        kind: "agent",
        tenantId: ctx.tenantId,
        agentId: virtualAgent.id,
        requestId: randomUUID(),
        printerIds: [],
      },
      now(),
      { agentVersion: "0.2.1-virtual", ip: "127.0.0.1" },
    );
    virtualAgent = {
      ...virtualAgent,
      lastSeenAt: now().toISOString(),
    };
  }

  // Find or provision Virtual Kitchen Printer
  let virtualPrinter = printers.find((p) => isVirtualAddress(p.connectionAddress) || p.name.includes("Virtual"));

  if (!virtualPrinter) {
    const virtualAddress = `virtual:${ctx.tenantId}:kitchen`;
    virtualPrinter = await withTx(ctx, async (tx) => {
      const created = await insertPrinter(tx, ctx, {
        name: "FlowDineOS Virtual Kitchen Printer",
        purpose: PrinterPurpose.KOT,
        connectionType: PrinterConnection.USB,
        connectionAddress: virtualAddress,
        paperWidthMm: 80,
        kitchenSectionId: null,
        printAgentId: virtualAgent!.id,
        profile: "VIRTUAL_ESCPOS",
      });

      await audit(tx, ctx, {
        action: "printer.created",
        resourceType: "printer",
        resourceId: created.id,
        after: { name: created.name, connectionAddress: virtualAddress, virtual: true },
      });

      return created;
    });
  }

  // Resolve adapter state and tickets
  const adapter = getVirtualPrinterAdapter(ctx.tenantId, virtualPrinter.connectionAddress ?? "virtual:kitchen");
  const emulatorState = adapter.getFullState();

  // Resolve print job counts
  const recentJobs = await listPrintJobsData(ctx, {}, 50);
  const queue = {
    queued: recentJobs.filter((j) => j.status === PrintJobStatus.PENDING && j.attemptCount === 0).length,
    retrying: recentJobs.filter((j) => j.status === PrintJobStatus.PENDING && j.attemptCount > 0).length,
    sending: recentJobs.filter((j) => j.status === PrintJobStatus.PROCESSING).length,
    delivered: recentJobs.filter((j) => j.status === PrintJobStatus.PRINTED).length,
    failed: recentJobs.filter((j) => j.status === PrintJobStatus.FAILED).length,
    cancelled: recentJobs.filter((j) => j.status === PrintJobStatus.CANCELLED).length,
  };

  const latest = recentJobs[0] ?? null;

  const agentPresence = getAgentPresenceStatus({
    status: virtualAgent.status,
    lastSeenAt: virtualAgent.lastSeenAt,
  });

  return {
    isVirtualEnabled: true,
    agent: {
      id: virtualAgent.id,
      name: virtualAgent.name,
      status: agentPresence,
      lastSeenAt: virtualAgent.lastSeenAt,
      version: virtualAgent.agentVersion,
      tokenPrefix: virtualAgent.tokenPrefix,
      pairedAt: virtualAgent.pairedAt,
    },
    printer: {
      id: virtualPrinter.id,
      name: virtualPrinter.name,
      connectionAddress: virtualPrinter.connectionAddress ?? "virtual:kitchen",
      paperWidthMm: virtualPrinter.paperWidthMm,
      profile: virtualPrinter.profile,
      purpose: virtualPrinter.purpose,
      health: virtualPrinter.health,
    },
    emulatorState,
    queue,
    latestJob: latest
      ? {
          id: latest.id,
          jobType: latest.jobType,
          status: latest.displayStatus,
          orderNumber: latest.orderNumber,
          kotNumber: latest.kotNumber,
          createdAt: latest.createdAt,
          printedAt: latest.printedAt,
        }
      : null,
    tickets: adapter.getTickets(),
  };
}

/**
 * Sets the failure simulation mode for a tenant's virtual printer.
 */
export async function setVirtualSimulationMode(
  ctx: TenantContext,
  printerId: string,
  mode: VirtualPrinterSimulationMode,
): Promise<VirtualPrinterState> {
  assertVirtualPrintingEnabled();

  const printer = await withTx(ctx, async (tx) => findPrinterRow(tx, ctx, printerId));
  if (!printer) throw new NotFoundError("Virtual printer not found");

  const adapter = getVirtualPrinterAdapter(ctx.tenantId, printer.connectionAddress);
  adapter.setSimulationMode(mode);
  logger.info("virtual_printer.simulation_mode_set", { tenantId: ctx.tenantId, printerId, mode });
  return adapter.getFullState();
}

/**
 * Clears the rendered virtual tickets.
 */
export async function clearVirtualTickets(ctx: TenantContext, printerId: string): Promise<void> {
  assertVirtualPrintingEnabled();

  const printer = await withTx(ctx, async (tx) => findPrinterRow(tx, ctx, printerId));
  if (!printer) throw new NotFoundError("Virtual printer not found");

  const adapter = getVirtualPrinterAdapter(ctx.tenantId, printer.connectionAddress);
  adapter.clearTickets();
}

/**
 * Enqueues a simulated realistic Kitchen Order Ticket (KOT) directly into the print queue
 * using the real `renderKotDocument` template and deduplication.
 */
export async function enqueueSimulatedKotJob(
  ctx: TenantContext,
  printerId: string,
  options: {
    orderNumber?: string;
    kotNumber?: string;
    table?: string;
    items?: Array<{ quantity: number; label: string; instructions?: string }>;
    notes?: string;
  } = {},
): Promise<{ jobId: string; dedupeKey: string }> {
  assertVirtualPrintingEnabled();

  const printer = await withTx(ctx, async (tx) => findPrinterRow(tx, ctx, printerId));
  if (!printer) throw new NotFoundError("Virtual printer not found");

  const kotNumber = options.kotNumber ?? `KOT-${Math.floor(100 + Math.random() * 900)}`;
  const orderNumber = options.orderNumber ?? `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
  const tableLabel = options.table ?? "Table 4";

  const defaultItems = [
    { quantity: 2, label: "Chicken Biryani", instructions: null },
    { quantity: 1, label: "Paneer Butter Masala", instructions: null },
    { quantity: 2, label: "Butter Naan", instructions: null },
  ];

  const items = options.items
    ? options.items.map((i) => ({ quantity: i.quantity, label: i.label, addons: null, instructions: i.instructions ?? null }))
    : defaultItems.map((i) => ({ ...i, addons: null }));

  const profile = await withTx(ctx, async (tx) => printingProfile(tx, ctx));

  const document = renderKotDocument({
    widthMm: printer.paperWidthMm,
    restaurantName: profile.name || "FlowDineOS Bistro",
    kotNumber,
    sectionName: "Kitchen",
    roundNumber: 1,
    orderNumber,
    orderType: "DINE_IN",
    tableLabel,
    priority: "NORMAL",
    queuedAt: now(),
    timeZone: profile.timezone || "Asia/Kolkata",
    notes: options.notes ?? "Less spicy",
    items,
  });

  const dedupeKey = `SIM_KOT:${orderNumber}:${kotNumber}`;

  const created = await withTx(ctx, async (tx) => {
    const job = await createPrintJob(tx, ctx, {
      printerId: printer.id,
      jobType: PrintJobType.KOT,
      dedupeKey,
      payload: document,
      requestedByUserId: ctx.userId,
    });

    await audit(tx, ctx, {
      action: "print_job.created",
      resourceType: "print_job",
      resourceId: job.id,
      after: { jobType: PrintJobType.KOT, dedupeKey, virtual: true },
    });

    return job;
  });

  return { jobId: created.id, dedupeKey };
}

/**
 * Runs one atomic claim & print cycle for the virtual agent directly.
 * Useful for instantaneous verification in automated tests or one-click delivery in UI.
 */
export async function executeVirtualAgentCycle(ctx: TenantContext, agentId: string): Promise<{
  claimedCount: number;
  results: Array<{ jobId: string; outcome: "DELIVERED" | "FAILED"; errorCode?: string }>;
}> {
  assertVirtualPrintingEnabled();

  const agent = await withTx(ctx, async (tx) => {
    return tx.printAgent.findFirst({
      where: { id: agentId, tenantId: ctx.tenantId },
    });
  });
  if (!agent) throw new NotFoundError("Agent not found");

  const agentCtx: AgentContext = {
    kind: "agent",
    tenantId: ctx.tenantId,
    agentId: agent.id,
    requestId: randomUUID(),
    printerIds: [],
  };

  await touchAgent(agentCtx, now(), { agentVersion: "0.2.1-virtual", ip: "127.0.0.1" });

  const claimed = await claimJobs(agentCtx, 10, now());
  const results: Array<{ jobId: string; outcome: "DELIVERED" | "FAILED"; errorCode?: string }> = [];

  for (const job of claimed) {
    const printer = await withTx(ctx, async (tx) => findPrinterRow(tx, ctx, job.printerId));
    if (!printer) {
      await ackJob(
        agentCtx,
        job.jobId,
        job.claimToken,
        {
          result: "FAILED",
          errorCode: "PRINTER_NOT_FOUND",
          errorMessage: "Printer not found",
        },
        now(),
      );
      results.push({ jobId: job.jobId, outcome: "FAILED", errorCode: "PRINTER_NOT_FOUND" });
      continue;
    }

    const adapter = getVirtualPrinterAdapter(ctx.tenantId, printer.connectionAddress);

    try {
      const doc = parsePrintDocument(job.payload);
      const bytes = encodeDocument(doc, { profile: profileOf(printer.profile) });

      await adapter.print(bytes, { jobId: job.jobId });
      await ackJob(
        agentCtx,
        job.jobId,
        job.claimToken,
        {
          result: "PRINTED",
        },
        now(),
      );
      results.push({ jobId: job.jobId, outcome: "DELIVERED" });
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? (err as { code: string }).code : "PRINT_SEND_FAILED";
      const message = err instanceof Error ? err.message : "Print failed";
      await ackJob(
        agentCtx,
        job.jobId,
        job.claimToken,
        {
          result: "FAILED",
          errorCode: code,
          errorMessage: message,
        },
        now(),
      );
      results.push({ jobId: job.jobId, outcome: "FAILED", errorCode: code });
    }
  }

  return { claimedCount: claimed.length, results };
}

/**
 * Touches the virtual agent's lastSeenAt heartbeat directly.
 */
export async function touchVirtualAgentHeartbeat(ctx: TenantContext, agentId: string): Promise<void> {
  assertVirtualPrintingEnabled();
  const agentCtx: AgentContext = {
    kind: "agent",
    tenantId: ctx.tenantId,
    agentId,
    requestId: randomUUID(),
    printerIds: [],
  };
  await touchAgent(agentCtx, now(), { agentVersion: "0.2.1-virtual", ip: "127.0.0.1" });
}
