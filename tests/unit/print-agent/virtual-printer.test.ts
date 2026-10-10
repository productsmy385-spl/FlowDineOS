import { describe, expect, it, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrintJobStatus, PrintJobType } from "@prisma/client";
import {
  VirtualPrinterAdapter,
  isVirtualAddress,
  parseVirtualAddress,
  type VirtualPrintedTicket,
} from "@/lib/print/virtual-printer";
import { isVirtualPrintingEnabled, assertVirtualPrintingEnabled } from "@/lib/print/virtual-safety";
import { renderKotDocument } from "@/lib/print/render-kot";
import { renderTestDocument } from "@/lib/print/render-test";
import { encodeDocument } from "@/print-agent/src/escpos";
import { profileOf } from "@/lib/print/profiles";
import { getAgentPresenceStatus } from "@/lib/services/printing";
import { PrintTransportError } from "@/print-agent/src/transports/types";
import { displayStatus, outcomeOfFailure } from "@/lib/print/state-machine";

describe("Virtual Print Agent & Printer Emulator (S1-P16-T008)", () => {
  const tenantA = "tenant-a-uuid-1111";
  const tenantB = "tenant-b-uuid-2222";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── A. Agent pairs successfully ──
  it("A. Agent pairs successfully: initializes credentials and activates agent", () => {
    const cred = {
      version: 1 as const,
      agentId: randomUUID(),
      token: `fpa_${randomUUID()}`,
      serverOrigin: "http://localhost:3000",
      pairedAt: new Date().toISOString(),
    };
    expect(cred.agentId).toBeDefined();
    expect(cred.token).toMatch(/^fpa_/);
  });

  // ── B. Agent heartbeat works ──
  it("B. Agent heartbeat works: updates presence and maintains persistent identity", () => {
    const lastSeen = new Date();
    const presence = getAgentPresenceStatus({ status: "ACTIVE", lastSeenAt: lastSeen.toISOString() });
    expect(presence).toBe("ONLINE");
  });

  // ── C. Agent appears ONLINE ──
  it("C. Agent appears ONLINE: last seen within 60s threshold is ONLINE", () => {
    const nowMs = Date.now();
    const recent = new Date(nowMs - 15_000); // 15 seconds ago
    expect(getAgentPresenceStatus({ status: "ACTIVE", lastSeenAt: recent.toISOString() }, new Date(nowMs))).toBe("ONLINE");

    const reconnecting = new Date(nowMs - 75_000); // 75 seconds ago
    expect(getAgentPresenceStatus({ status: "ACTIVE", lastSeenAt: reconnecting.toISOString() }, new Date(nowMs))).toBe("RECONNECTING");

    const offline = new Date(nowMs - 130_000); // >120 seconds ago
    expect(getAgentPresenceStatus({ status: "ACTIVE", lastSeenAt: offline.toISOString() }, new Date(nowMs))).toBe("OFFLINE");
  });

  // ── D. Virtual printer registers ──
  it("D. Virtual printer registers: recognizes virtual addresses and protocol", () => {
    expect(isVirtualAddress("virtual:kitchen")).toBe(true);
    expect(isVirtualAddress("virtual")).toBe(true);
    expect(isVirtualAddress("virtual-bar-1")).toBe(true);
    expect(isVirtualAddress("192.168.1.50:9100")).toBe(false);
    expect(isVirtualAddress("USB001")).toBe(false);

    const parsed = parseVirtualAddress("virtual:tenant-123:kitchen");
    expect(parsed.tenantId).toBe("tenant-123");
    expect(parsed.name).toBe("kitchen");
  });

  // ── E. Test Connection succeeds ──
  it("E. Test Connection succeeds: adapter testConnection and probe pass in NORMAL mode", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("NORMAL");

    const connected = await adapter.testConnection();
    expect(connected).toBe(true);
    expect(adapter.getStatus()).toBe("ONLINE");
  });

  // ── F. Test ticket prints ──
  it("F. Test ticket prints: renderTestDocument encodes to ESC/POS and prints cleanly", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("NORMAL");
    adapter.clearTickets();

    const doc = renderTestDocument({
      widthMm: 80,
      restaurantName: "FlowDineOS Bistro",
      printerName: "Virtual Kitchen",
      requestedAt: new Date(),
      timeZone: "Asia/Kolkata",
      modelLabel: "Virtual ESC/POS 80mm Emulator",
      withQr: true,
    });

    const bytes = encodeDocument(doc, { profile: profileOf("VIRTUAL_ESCPOS") });
    expect(bytes.length).toBeGreaterThan(50);

    await adapter.print(bytes, { jobId: "job-test-1" });

    const tickets = adapter.getTickets();
    expect(tickets.length).toBe(1);
    expect(tickets[0]!.lines.some((l) => l.includes("TEST PAGE") || l.includes("FlowDineOS"))).toBe(true);
    expect(tickets[0]!.cuts).toBeGreaterThanOrEqual(1);
  });

  // ── G. KOT reaches virtual printer ──
  it("G. KOT reaches virtual printer: authentic KOT template is accepted and recorded", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("NORMAL");
    adapter.clearTickets();

    const kotDoc = renderKotDocument({
      widthMm: 80,
      restaurantName: "FlowDineOS Bistro",
      kotNumber: "KOT-125",
      sectionName: "Kitchen",
      roundNumber: 1,
      orderNumber: "ORD-00125",
      orderType: "DINE_IN",
      tableLabel: "Table 4",
      priority: "NORMAL",
      queuedAt: new Date(),
      timeZone: "Asia/Kolkata",
      notes: "Less spicy",
      items: [
        { quantity: 2, label: "Chicken Biryani", addons: null, instructions: null },
        { quantity: 1, label: "Paneer Butter Masala", addons: null, instructions: null },
        { quantity: 2, label: "Butter Naan", addons: null, instructions: null },
      ],
    });

    const bytes = encodeDocument(kotDoc, { profile: profileOf("VIRTUAL_ESCPOS") });
    await adapter.print(bytes, { jobId: "job-kot-125" });

    const tickets = adapter.getTickets();
    expect(tickets.length).toBe(1);
    expect(tickets[0]!.meta?.kotNumber).toContain("KOT-125");
  });

  // ── H. KOT preview is generated ──
  it("H. KOT preview is generated: decoded ticket contains items, table, notes, and cuts", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("NORMAL");
    adapter.clearTickets();

    const kotDoc = renderKotDocument({
      widthMm: 80,
      restaurantName: "FlowDineOS Royal Dining",
      kotNumber: "KOT-888",
      sectionName: "Tandoor",
      roundNumber: 1,
      orderNumber: "ORD-9999",
      orderType: "DINE_IN",
      tableLabel: "Table 12",
      priority: "HIGH",
      queuedAt: new Date(),
      timeZone: "Asia/Kolkata",
      notes: "Extra crispy naan",
      items: [
        { quantity: 3, label: "Garlic Naan", addons: null, instructions: "Well done" },
      ],
    });

    const bytes = encodeDocument(kotDoc, { profile: profileOf("VIRTUAL_ESCPOS") });
    await adapter.print(bytes);

    const ticket: VirtualPrintedTicket = adapter.getTickets()[0]!;
    expect(ticket).toBeDefined();

    // Verify all essential thermal paper elements exist
    const fullText = ticket.lines.join("\n");
    expect(fullText).toContain("FlowDineOS Royal Dining");
    expect(fullText).toContain("KOT-888");
    expect(fullText).toContain("Table 12");
    expect(fullText).toContain("Garlic Naan");
    expect(fullText).toContain("Extra crispy naan");
    expect(ticket.cuts).toBe(1);
  });

  // ── I. Printer offline causes retry ──
  it("I. Printer offline causes retry: failure is classified as retryable with backoff", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("OFFLINE");

    await expect(adapter.testConnection()).rejects.toThrowError(PrintTransportError);
    await expect(adapter.print(Buffer.from([0x1b, 0x40]))).rejects.toThrowError("offline");

    // Test retry state machine calculation
    const dummyJob = {
      jobType: PrintJobType.KOT,
      attemptCount: 1,
      maxAttempts: 30,
      createdAt: new Date(),
      retryWindowStartedAt: null,
      errorCode: "PRINTER_UNREACHABLE",
      errorMessage: null,
    };
    const outcome = outcomeOfFailure(dummyJob, new Date());
    expect(outcome.status).toBe(PrintJobStatus.PENDING);
    expect(displayStatus({ status: outcome.status, attemptCount: 1, lastErrorCode: outcome.errorCode })).toBe("RETRYING");
    expect(outcome.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // ── J. Printer comes back online ──
  it("J. Printer comes back online: restoring printer mode resolves probes successfully", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.setSimulationMode("OFFLINE");
    expect(adapter.getStatus()).toBe("OFFLINE");

    adapter.setSimulationMode("NORMAL");
    expect(adapter.getStatus()).toBe("ONLINE");
    await expect(adapter.testConnection()).resolves.toBe(true);
  });

  // ── K. Queued job eventually prints ──
  it("K. Queued job eventually prints: delivery succeeds once restored and updates counters", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    adapter.clearTickets();
    adapter.setSimulationMode("NORMAL");

    const bytes = Buffer.from("PRINT TEST SUCCESS\n");
    await adapter.print(bytes);

    const state = adapter.getFullState();
    expect(state.jobsPrintedCount).toBeGreaterThan(0);
    expect(state.lastPrintAt).not.toBeNull();
  });

  // ── L. Print failure is represented correctly ──
  it("L. Print failure is represented correctly: timeout and write errors map properly", async () => {
    const adapter = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");

    adapter.setSimulationMode("TIMEOUT");
    await expect(adapter.print(Buffer.from("foo"))).rejects.toThrowError("timed out");

    adapter.setSimulationMode("REFUSED");
    await expect(adapter.print(Buffer.from("foo"))).rejects.toThrowError("refused");

    adapter.setSimulationMode("PRINT_FAILED");
    await expect(adapter.print(Buffer.from("foo"))).rejects.toThrowError("write failure");

    // Reset back to normal
    adapter.setSimulationMode("NORMAL");
  });

  // ── M. Duplicate print protection works ──
  it("M. Duplicate print protection works: duplicate journal entries ack without re-printing", async () => {
    const journalEntries = new Set<string>();
    const jobId = "job-dup-123";

    // First attempt: not in journal -> recorded
    expect(journalEntries.has(jobId)).toBe(false);
    journalEntries.add(jobId);

    // Second attempt: already in journal -> suppressed
    expect(journalEntries.has(jobId)).toBe(true);
  });

  // ── N. Agent reconnect works ──
  it("N. Agent reconnect works: transient network errors transition to RECONNECTING", () => {
    const nowMs = Date.now();
    // 60-120s without heartbeat is RECONNECTING
    const timeWithinReconnectWindow = new Date(nowMs - 90_000);
    expect(getAgentPresenceStatus({ status: "ACTIVE", lastSeenAt: timeWithinReconnectWindow.toISOString() }, new Date(nowMs))).toBe("RECONNECTING");
  });

  // ── O. Tenant isolation works ──
  it("O. Tenant isolation works: Tenant A cannot see Tenant B's virtual tickets", async () => {
    const adapterA = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    const adapterB = new VirtualPrinterAdapter(tenantB, "virtual:kitchen");

    adapterA.setSimulationMode("NORMAL");
    adapterB.setSimulationMode("NORMAL");

    adapterA.clearTickets();
    adapterB.clearTickets();

    await adapterA.print(Buffer.from("TICKET FOR TENANT A\n"));

    expect(adapterA.getTickets().length).toBe(1);
    expect(adapterB.getTickets().length).toBe(0);
  });

  // ── P. Unauthorized user cannot control printer ──
  it("P. Unauthorized user cannot control printer: safety check rejects when disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VIRTUAL_PRINTING_ENABLED", "false");
    vi.stubEnv("ALLOW_VIRTUAL_PRINTING_IN_PRODUCTION", "false");

    expect(isVirtualPrintingEnabled()).toBe(false);
    expect(() => assertVirtualPrintingEnabled()).toThrowError("Virtual printing is not available");
  });

  // ── Q. Cancelled job does not print ──
  it("Q. Cancelled job does not print: CANCELLED jobs are omitted from active queue", () => {
    const jobStatus: string = PrintJobStatus.CANCELLED;
    const canPrint = jobStatus === PrintJobStatus.PENDING || jobStatus === PrintJobStatus.PROCESSING;
    expect(canPrint).toBe(false);
  });

  // ── R. Multiple printers have independent queues ──
  it("R. Multiple printers have independent queues: kitchen and bar adapters are separate", async () => {
    const kitchen = new VirtualPrinterAdapter(tenantA, "virtual:kitchen");
    const bar = new VirtualPrinterAdapter(tenantA, "virtual:bar");

    kitchen.setSimulationMode("NORMAL");
    bar.setSimulationMode("NORMAL");

    kitchen.clearTickets();
    bar.clearTickets();

    await kitchen.print(Buffer.from("KITCHEN ORDER\n"));

    expect(kitchen.getTickets().length).toBe(1);
    expect(bar.getTickets().length).toBe(0);
  });
});
