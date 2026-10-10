import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrintTransportError, type Transport } from "@/print-agent/src/transports/types";
import { decodeEscPos, type DecodedTicket } from "@/tools/printer-simulator/decode";
import { assertVirtualPrintingEnabled } from "./virtual-safety";

export type VirtualPrinterSimulationMode =
  | "NORMAL"
  | "OFFLINE"
  | "TIMEOUT"
  | "REFUSED"
  | "SLOW"
  | "PRINT_FAILED";

export type VirtualPrintedTicket = {
  id: string;
  tenantId: string;
  printerAddress: string;
  printedAt: string;
  rawBytesBase64: string;
  byteLength: number;
  cuts: number;
  lines: string[];
  bold: boolean[];
  align: Array<"left" | "center" | "right">;
  jobId?: string;
  dedupeKey?: string;
  meta?: {
    kotNumber?: string;
    orderNumber?: string;
    table?: string;
    restaurantName?: string;
  };
};

export type VirtualPrinterState = {
  tenantId: string;
  printerAddress: string;
  printerName: string;
  status: "READY" | "OFFLINE" | "ERROR";
  simulationMode: VirtualPrinterSimulationMode;
  slowDelayMs: number;
  jobsPrintedCount: number;
  jobsFailedCount: number;
  lastPrintAt: string | null;
  lastError: string | null;
  tickets: VirtualPrintedTicket[];
};

const DEFAULT_SLOW_DELAY_MS = 1_500;

function resolveStateFile(tenantId: string, printerAddress = "virtual:kitchen"): string {
  // Safe sanitization of tenantId and address for file path
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeAddr = printerAddress.replace(/[^a-zA-Z0-9_-]/g, "_");
  const baseDir = path.join(process.cwd(), ".flowdineos", "virtual-printers");
  mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, `${safeTenant}_${safeAddr}.json`);
}

/**
 * VirtualPrinterAdapter implements the printer adapter / transport interface for dev & testing.
 *
 * It satisfies:
 * 1. Physical adapter conceptual methods: `connect()`, `disconnect()`, `print()`, `testConnection()`, `getStatus()`
 * 2. Transport interface: `send(bytes: Buffer)`, `probe()`
 * 3. Failure simulation controls: offline, timeout, connection refused, slow printer, print failure.
 * 4. Realistic ESC/POS decoding into 80mm thermal paper tickets.
 */
export class VirtualPrinterAdapter implements Transport {
  readonly tenantId: string;
  readonly printerAddress: string;
  private isConnected = true;

  constructor(tenantId: string, printerAddress = "virtual:kitchen") {
    this.tenantId = tenantId;
    this.printerAddress = printerAddress;
  }

  private getState(): VirtualPrinterState {
    const file = resolveStateFile(this.tenantId, this.printerAddress);
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, "utf8");
        return JSON.parse(raw) as VirtualPrinterState;
      } catch {
        // Fall back to default on corrupt read
      }
    }
    return {
      tenantId: this.tenantId,
      printerAddress: this.printerAddress,
      printerName: "FlowDineOS Virtual Kitchen Printer",
      status: "READY",
      simulationMode: "NORMAL",
      slowDelayMs: DEFAULT_SLOW_DELAY_MS,
      jobsPrintedCount: 0,
      jobsFailedCount: 0,
      lastPrintAt: null,
      lastError: null,
      tickets: [],
    };
  }

  private saveState(state: VirtualPrinterState): void {
    const file = resolveStateFile(this.tenantId, this.printerAddress);
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  }

  // ── Conceptual physical adapter methods ──

  async connect(): Promise<void> {
    assertVirtualPrintingEnabled();
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async testConnection(): Promise<boolean> {
    await this.probe();
    return true;
  }

  getStatus(): "ONLINE" | "OFFLINE" | "ERROR" {
    const state = this.getState();
    if (!this.isConnected || state.simulationMode === "OFFLINE") return "OFFLINE";
    if (state.simulationMode === "PRINT_FAILED" || state.simulationMode === "REFUSED") return "ERROR";
    return "ONLINE";
  }

  getSimulationMode(): VirtualPrinterSimulationMode {
    return this.getState().simulationMode;
  }

  setSimulationMode(mode: VirtualPrinterSimulationMode, slowDelayMs = DEFAULT_SLOW_DELAY_MS): void {
    assertVirtualPrintingEnabled();
    const state = this.getState();
    state.simulationMode = mode;
    state.slowDelayMs = slowDelayMs;
    state.status = mode === "NORMAL" || mode === "SLOW" ? "READY" : mode === "OFFLINE" ? "OFFLINE" : "ERROR";
    this.saveState(state);
  }

  clearTickets(): void {
    assertVirtualPrintingEnabled();
    const state = this.getState();
    state.tickets = [];
    state.lastPrintAt = null;
    this.saveState(state);
  }

  getTickets(): VirtualPrintedTicket[] {
    return this.getState().tickets;
  }

  getFullState(): VirtualPrinterState {
    return this.getState();
  }

  // ── Transport interface implementation (`probe` and `send`) ──

  async probe(): Promise<void> {
    const state = this.getState();
    if (!this.isConnected || state.simulationMode === "OFFLINE") {
      throw new PrintTransportError("PRINTER_UNREACHABLE", `Virtual printer ${this.printerAddress} is offline (simulated)`);
    }
    if (state.simulationMode === "TIMEOUT") {
      await new Promise((r) => setTimeout(r, 100));
      throw new PrintTransportError("CONNECTION_TIMEOUT", `Connection to virtual printer ${this.printerAddress} timed out (simulated)`);
    }
    if (state.simulationMode === "REFUSED") {
      throw new PrintTransportError("CONNECTION_REFUSED", `Connection to virtual printer ${this.printerAddress} was refused (simulated)`);
    }
    if (state.simulationMode === "SLOW") {
      await new Promise((r) => setTimeout(r, Math.min(state.slowDelayMs, 1000)));
    }
  }

  async send(bytes: Buffer): Promise<void> {
    await this.print(bytes);
  }

  async print(bytes: Buffer, context?: { jobId?: string; dedupeKey?: string }): Promise<void> {
    const state = this.getState();

    // Check fault simulation modes
    if (!this.isConnected || state.simulationMode === "OFFLINE") {
      state.jobsFailedCount += 1;
      state.lastError = "PRINTER_UNREACHABLE";
      this.saveState(state);
      throw new PrintTransportError("PRINTER_UNREACHABLE", `Virtual printer ${this.printerAddress} is offline (simulated)`);
    }

    if (state.simulationMode === "TIMEOUT") {
      state.jobsFailedCount += 1;
      state.lastError = "CONNECTION_TIMEOUT";
      this.saveState(state);
      await new Promise((r) => setTimeout(r, 100));
      throw new PrintTransportError("CONNECTION_TIMEOUT", `Printing to virtual printer ${this.printerAddress} timed out (simulated)`);
    }

    if (state.simulationMode === "REFUSED") {
      state.jobsFailedCount += 1;
      state.lastError = "CONNECTION_REFUSED";
      this.saveState(state);
      throw new PrintTransportError("CONNECTION_REFUSED", `Virtual printer ${this.printerAddress} connection was refused (simulated)`);
    }

    if (state.simulationMode === "PRINT_FAILED") {
      state.jobsFailedCount += 1;
      state.lastError = "PRINT_SEND_FAILED";
      this.saveState(state);
      throw new PrintTransportError("PRINT_SEND_FAILED", `Virtual printer ${this.printerAddress} write failure / paper jam (simulated)`);
    }

    if (state.simulationMode === "SLOW") {
      await new Promise((r) => setTimeout(r, state.slowDelayMs));
    }

    // Decode ESC/POS bytes into structured thermal ticket lines
    const decoded: DecodedTicket = decodeEscPos(bytes);
    const printedAt = new Date().toISOString();

    // Extract quick metadata from decoded lines if present
    const meta: VirtualPrintedTicket["meta"] = {};
    for (const line of decoded.lines) {
      const trimmed = line.trim();
      if (/^KOT\s*#?(\S+)/i.test(trimmed)) meta.kotNumber = trimmed;
      if (/^Order\s*[:\s]*(\S+)/i.test(trimmed)) meta.orderNumber = trimmed;
      if (/^Table\s*[:\s]*(.+)/i.test(trimmed)) meta.table = trimmed;
    }
    if (decoded.lines.length > 0 && decoded.lines[0]?.trim()) {
      meta.restaurantName = decoded.lines[0].trim();
    }

    const ticket: VirtualPrintedTicket = {
      id: `vpt_${randomUUID()}`,
      tenantId: this.tenantId,
      printerAddress: this.printerAddress,
      printedAt,
      rawBytesBase64: bytes.toString("base64"),
      byteLength: bytes.length,
      cuts: decoded.cuts,
      lines: decoded.lines,
      bold: decoded.bold,
      align: decoded.align,
      jobId: context?.jobId,
      dedupeKey: context?.dedupeKey,
      meta,
    };

    state.tickets = [ticket, ...state.tickets].slice(0, 50);
    state.jobsPrintedCount += 1;
    state.lastPrintAt = printedAt;
    state.lastError = null;
    this.saveState(state);
  }
}

/** Registry of virtual printer adapters */
const adapters = new Map<string, VirtualPrinterAdapter>();

export function getVirtualPrinterAdapter(tenantId: string, printerAddress = "virtual:kitchen"): VirtualPrinterAdapter {
  const key = `${tenantId}:${printerAddress}`;
  let adapter = adapters.get(key);
  if (!adapter) {
    adapter = new VirtualPrinterAdapter(tenantId, printerAddress);
    adapters.set(key, adapter);
  }
  return adapter;
}

export function isVirtualAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  return lower === "virtual" || lower.startsWith("virtual:") || lower.startsWith("virtual-");
}

export function parseVirtualAddress(address: string): { tenantId?: string; name: string } {
  const parts = address.split(":");
  if (parts.length >= 3) {
    return { tenantId: parts[1], name: parts.slice(2).join(":") };
  }
  if (parts.length === 2) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]!)) {
      return { tenantId: parts[1], name: "kitchen" };
    }
    return { name: parts[1]! };
  }
  return { name: "kitchen" };
}
