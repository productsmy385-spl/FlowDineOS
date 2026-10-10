"use server";

import { requireTenant } from "@/lib/auth/guards";
import { action } from "@/lib/http/action";
import { assertVirtualPrintingEnabled } from "@/lib/print/virtual-safety";
import { createTestPrintJob, startPrinterCheck } from "@/lib/services/printing";
import {
  clearVirtualTickets,
  enqueueSimulatedKotJob,
  executeVirtualAgentCycle,
  getOrCreateVirtualEnvironment,
  setVirtualSimulationMode,
} from "@/lib/services/virtual-printing";
import type { VirtualPrinterSimulationMode } from "@/lib/print/virtual-printer";

export const getVirtualEnvironmentAction = action(async () => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return getOrCreateVirtualEnvironment(ctx);
});

export const setSimulationModeAction = action(async (input: { printerId: string; mode: VirtualPrinterSimulationMode }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return setVirtualSimulationMode(ctx, input.printerId, input.mode);
});

export const clearTicketsAction = action(async (input: { printerId: string }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return clearVirtualTickets(ctx, input.printerId);
});

export const triggerTestConnectionAction = action(async (input: { printerId: string }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return startPrinterCheck(ctx, input.printerId);
});

export const triggerTestPrintAction = action(async (input: { printerId: string }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return createTestPrintJob(ctx, input.printerId);
});

export const triggerSimulatedKotAction = action(
  async (input: {
    printerId: string;
    orderNumber?: string;
    kotNumber?: string;
    table?: string;
    notes?: string;
  }) => {
    const ctx = await requireTenant("printer:manage");
    assertVirtualPrintingEnabled();
    const { printerId, ...rest } = input;
    return enqueueSimulatedKotJob(ctx, printerId, rest);
  },
);

export const executeCycleAction = action(async (input: { agentId: string }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();
  return executeVirtualAgentCycle(ctx, input.agentId);
});

export const simulateDuplicatePrintAction = action(async (input: { printerId: string }) => {
  const ctx = await requireTenant("printer:manage");
  assertVirtualPrintingEnabled();

  const fixedKot = `KOT-DUP-${Date.now()}`;
  const fixedOrder = `ORD-DUP-999`;
  const first = await enqueueSimulatedKotJob(ctx, input.printerId, {
    kotNumber: fixedKot,
    orderNumber: fixedOrder,
  });

  let duplicateRejected = false;
  try {
    await enqueueSimulatedKotJob(ctx, input.printerId, {
      kotNumber: fixedKot,
      orderNumber: fixedOrder,
    });
  } catch {
    duplicateRejected = true;
  }

  return {
    firstJobId: first.jobId,
    duplicateRejected,
  };
});
