import net from "node:net";
import { DEFAULT_TIMEOUTS, PrintTransportError, type Transport, type TransportTimeouts } from "./types";

/**
 * Raw TCP (JetDirect / "port 9100") transport for Wi-Fi and Ethernet ESC/POS printers (S1-P17-T006, TC-AGENT-014).
 *
 * The agent only ever connects out; it never listens (T-028). Timeouts: 5 s to connect, 10 s to hand over the bytes.
 * Each socket outcome maps to one catalogue code (lib/print/error-codes.ts, printing audit 2026-10-08 D1/D4):
 *
 * - no answer to the connection → CONNECTION_TIMEOUT; refused → CONNECTION_REFUSED; no route → PRINTER_UNREACHABLE
 * - reset or failure before any byte was sent → CONNECTION_RESET / PRINT_SEND_FAILED (safe to retry)
 * - the printer stopped taking data after part of the ticket was sent → DELIVERY_UNKNOWN: something may already be on
 *   paper, so it is never retried automatically (a person decides).
 */
const UNREACHABLE = new Set(["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENOTFOUND", "EADDRNOTAVAIL"]);
const RESET = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

export function mapSocketError(error: NodeJS.ErrnoException, host: string, port: number, sentBytes: number): PrintTransportError {
  const where = `${host}:${port}`;
  const errno = error.code ?? "error";
  if (sentBytes > 0) return new PrintTransportError("DELIVERY_UNKNOWN", `TCP ${where}: the connection failed after ${sentBytes} bytes were sent (${errno})`);
  if (errno === "ECONNREFUSED") return new PrintTransportError("CONNECTION_REFUSED", `TCP ${where}: connection refused`);
  if (errno === "ETIMEDOUT") return new PrintTransportError("CONNECTION_TIMEOUT", `TCP ${where}: no answer to the connection`);
  if (UNREACHABLE.has(errno)) return new PrintTransportError("PRINTER_UNREACHABLE", `TCP ${where}: host unreachable (${errno})`);
  if (RESET.has(errno)) return new PrintTransportError("CONNECTION_RESET", `TCP ${where}: connection reset by the printer (${errno})`);
  return new PrintTransportError("PRINT_SEND_FAILED", `TCP ${where}: connection failed (${errno})`);
}

export class LanTransport implements Transport {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  send(bytes: Buffer): Promise<void> {
    return this.connect(bytes);
  }

  probe(): Promise<void> {
    return this.connect(null);
  }

  private connect(bytes: Buffer | null): Promise<void> {
    const { host, port, timeouts } = this;
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      let connected = false;
      let timer: NodeJS.Timeout | undefined;
      const sent = () => (connected ? socket.bytesWritten : 0);

      const finish = (error?: PrintTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          // Half-closed and flushed; let the printer close its side, but never keep the socket alive for long.
          socket.setTimeout(2_000, () => socket.destroy());
          resolve();
        }
      };

      timer = setTimeout(
        () => finish(new PrintTransportError("CONNECTION_TIMEOUT", `TCP ${host}:${port}: no answer within ${timeouts.connectMs / 1000} s`)),
        timeouts.connectMs,
      );
      socket.once("error", (error: NodeJS.ErrnoException) => finish(mapSocketError(error, host, port, sent())));
      socket.once("connect", () => {
        connected = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const written = sent();
          finish(
            written > 0
              ? new PrintTransportError("DELIVERY_UNKNOWN", `TCP ${host}:${port}: the printer stopped accepting data after ${written} bytes`)
              : new PrintTransportError("PRINT_SEND_FAILED", `TCP ${host}:${port}: connected, but the printer accepted no data`),
          );
        }, timeouts.writeMs);
        if (bytes === null) socket.end(() => finish());
        else socket.end(bytes, () => finish());
      });
      // Nothing is read from the printer; drain whatever it sends so the socket never back-pressures.
      socket.on("data", () => undefined);
    });
  }
}
