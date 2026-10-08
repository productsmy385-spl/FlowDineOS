import type { PrintErrorCode } from "@/lib/print/error-codes";

/**
 * A way of getting bytes to one physical printer (S1-P17-T006). `send` resolves only once the bytes were handed to the
 * printer connection and it closed cleanly; `probe` checks reachability without printing anything.
 *
 * Error codes come from the shared catalogue (lib/print/error-codes.ts, printing audit 2026-10-08).
 */
export type TransportErrorCode = Extract<
  PrintErrorCode,
  | "PRINTER_UNREACHABLE"
  | "CONNECTION_TIMEOUT"
  | "CONNECTION_REFUSED"
  | "CONNECTION_RESET"
  | "PRINT_SEND_FAILED"
  | "DELIVERY_UNKNOWN"
  | "INVALID_PRINTER_CONFIGURATION"
  | "UNSUPPORTED_PRINTER"
>;

export class PrintTransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrintTransportError";
  }
}

export interface Transport {
  send(bytes: Buffer): Promise<void>;
  probe(): Promise<void>;
}

export type TransportTimeouts = { connectMs: number; writeMs: number };
export const DEFAULT_TIMEOUTS: TransportTimeouts = { connectMs: 5_000, writeMs: 10_000 };

/** Codes that mean the printer could not be reached at all — its health is OFFLINE, not ERROR. */
export const UNREACHABLE_CODES: ReadonlySet<TransportErrorCode> = new Set(["PRINTER_UNREACHABLE", "CONNECTION_TIMEOUT", "CONNECTION_REFUSED"]);
