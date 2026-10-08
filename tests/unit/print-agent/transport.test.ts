import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@/print-agent/src/logger";
import { JOURNAL_RETENTION_MS, PrintedJournal } from "@/print-agent/src/journal";
import { transportFor } from "@/print-agent/src/transports";
import { LanTransport, mapSocketError } from "@/print-agent/src/transports/lan";
import { PrintTransportError, UNREACHABLE_CODES } from "@/print-agent/src/transports/types";
import { usbDevicePath } from "@/print-agent/src/transports/usb";
import { decodeEscPos } from "@/tools/printer-simulator/decode";
import { startPrinterSimulator, type PrinterSimulator } from "@/tools/printer-simulator/server";

/** TC-AGENT-014 (transports), TC-AGENT-015 (simulator) and the printed-job journal — S1-P17-T004/T006/T007. */
let simulator: PrinterSimulator;
beforeEach(async () => {
  simulator = await startPrinterSimulator();
});
afterEach(async () => {
  await simulator.stop();
});

const quick = { connectMs: 1_000, writeMs: 1_000 };

describe("TC-AGENT-014 LAN transport", () => {
  it("delivers the bytes as one ticket", async () => {
    await new LanTransport(simulator.host, simulator.port, quick).send(Buffer.from("Hello\n\x1dV\x01", "latin1"));
    const [ticket] = await simulator.waitForTickets(1);
    expect(decodeEscPos(ticket!)).toMatchObject({ lines: ["Hello"], cuts: 1 });
  });

  it("a probe connects without printing anything", async () => {
    await new LanTransport(simulator.host, simulator.port, quick).probe();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(simulator.tickets).toHaveLength(0);
  });

  it("printer switched off → CONNECTION_REFUSED (its health shows Offline)", async () => {
    await simulator.setMode("offline");
    const error = await new LanTransport(simulator.host, simulator.port, quick).send(Buffer.from("x")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrintTransportError);
    expect((error as PrintTransportError).code).toBe("CONNECTION_REFUSED");
    expect(UNREACHABLE_CODES.has("CONNECTION_REFUSED")).toBe(true);
    await expect(new LanTransport(simulator.host, simulator.port, quick).probe()).rejects.toMatchObject({ code: "CONNECTION_REFUSED" });

    await simulator.setMode("normal");
    await new LanTransport(simulator.host, simulator.port, quick).send(Buffer.from("back\n"));
    expect(await simulator.waitForTickets(1)).toHaveLength(1);
  });

  it("an address that never answers → CONNECTION_TIMEOUT, never a paper problem (bounded, not hung)", async () => {
    // TEST-NET-1 (RFC 5737) is never routed; the connect attempt hangs until our timeout fires.
    const started = Date.now();
    const error = await new LanTransport("192.0.2.1", 9100, { connectMs: 300, writeMs: 300 }).probe().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(["CONNECTION_TIMEOUT", "PRINTER_UNREACHABLE"]).toContain((error as PrintTransportError).code);
  });

  it("refuses public, loopback and hostname addresses before connecting (SC-PRINT-06)", () => {
    for (const connectionAddress of ["8.8.8.8:9100", "127.0.0.1:9100", "printer.local:9100", "localhost"]) {
      expect(() => transportFor({ connectionType: "LAN", connectionAddress })).toThrow(PrintTransportError);
    }
    expect(transportFor({ connectionType: "LAN", connectionAddress: "192.168.1.50" })).toBeInstanceOf(LanTransport);
  });
});

describe("TC-AGENT-014 USB device paths", () => {
  it("Windows: a printer share on this PC only", () => {
    expect(usbDevicePath("KitchenPrinter", "win32")).toBe("\\\\localhost\\KitchenPrinter");
    expect(usbDevicePath("Star TSP100 (copy 1)", "win32")).toBe("\\\\localhost\\Star TSP100 (copy 1)");
    for (const bad of ["other-pc\\share", "C:/Windows/win.ini", "..\\x", "a/b"]) {
      expect(() => usbDevicePath(bad, "win32"), bad).toThrow(PrintTransportError);
    }
  });

  it("Linux: usblp devices only", () => {
    expect(usbDevicePath("lp0", "linux")).toBe("/dev/usb/lp0");
    expect(usbDevicePath("usb/lp1", "linux")).toBe("/dev/usb/lp1");
    for (const bad of ["sda", "usb/../sda", "lp0/../../etc/passwd", "etc/shadow"]) {
      expect(() => usbDevicePath(bad, "linux"), bad).toThrow(PrintTransportError);
    }
  });
});

describe("TC-AGENT-015 simulator fault modes", () => {
  it("reset drops the connection mid-job", async () => {
    await simulator.setMode("reset");
    const payload = Buffer.alloc(512 * 1024, 0x41);
    const error = await new LanTransport(simulator.host, simulator.port, quick).send(payload).catch((e: unknown) => e);
    // Depending on timing the kernel may have buffered the bytes already; either way no ticket was recorded.
    if (error) expect(error).toBeInstanceOf(PrintTransportError);
    expect(simulator.tickets).toHaveLength(0);
  });

  it("stall: the printer never drains — no ticket, and send settles within its write timeout", async () => {
    await simulator.setMode("stall");
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const started = Date.now();
    // Whether the OS buffers 8 MB on loopback (resolve) or pushes back (TIMEOUT) is platform-specific; what matters
    // is that the agent is never stuck on a dead printer and never claims paper came out.
    const error = await new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 500 }).send(payload).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    // A printer that took part of the ticket and stopped may have printed it: DELIVERY_UNKNOWN, never retried blindly.
    if (error) expect(["DELIVERY_UNKNOWN", "PRINT_SEND_FAILED"]).toContain((error as PrintTransportError).code);
    expect(simulator.tickets).toHaveLength(0);
  });
});

describe("printed-job journal (ADR-007 §5)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rasoios-journal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("survives a restart and forgets entries after 24 h", async () => {
    let now = Date.parse("2026-09-23T10:00:00Z");
    const file = path.join(dir, "journal.json");
    const first = new PrintedJournal(file, createLogger("error", () => undefined), () => now);
    await first.record("job-1");

    const second = new PrintedJournal(file, createLogger("error", () => undefined), () => now);
    await second.load();
    expect(second.has("job-1")).toBe(true);
    expect(second.has("job-2")).toBe(false);

    now += JOURNAL_RETENTION_MS + 1;
    expect(second.has("job-1")).toBe(false);
  });

  it("a corrupt journal is set aside instead of stopping the agent", async () => {
    const file = path.join(dir, "journal.json");
    const { writeFile, readdir } = await import("node:fs/promises");
    await writeFile(file, "{not json");
    const journal = new PrintedJournal(file, createLogger("error", () => undefined));
    await journal.load();
    expect(journal.size).toBe(0);
    expect((await readdir(dir)).some((name) => name.startsWith("journal.json.corrupt-"))).toBe(true);
  });
});

describe("TC-AGENT-016 every socket outcome maps to one catalogue code (printing audit 2026-10-08)", () => {
  const err = (code: string) => Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
  it("before any byte is sent", () => {
    expect(mapSocketError(err("ECONNREFUSED"), "192.168.1.103", 9100, 0).code).toBe("CONNECTION_REFUSED");
    expect(mapSocketError(err("ETIMEDOUT"), "192.168.1.103", 9100, 0).code).toBe("CONNECTION_TIMEOUT");
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"]) expect(mapSocketError(err(code), "192.168.1.103", 9100, 0).code, code).toBe("PRINTER_UNREACHABLE");
    for (const code of ["ECONNRESET", "EPIPE"]) expect(mapSocketError(err(code), "192.168.1.103", 9100, 0).code, code).toBe("CONNECTION_RESET");
    expect(mapSocketError(err("EWHATEVER"), "192.168.1.103", 9100, 0).code).toBe("PRINT_SEND_FAILED");
  });

  it("after part of the ticket was sent, any failure is DELIVERY_UNKNOWN", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT"]) expect(mapSocketError(err(code), "192.168.1.103", 9100, 512).code, code).toBe("DELIVERY_UNKNOWN");
  });

  it("the technical message names the address and port, never anything secret", () => {
    expect(mapSocketError(err("ETIMEDOUT"), "192.168.1.103", 9100, 0).message).toBe("TCP 192.168.1.103:9100: no answer to the connection");
  });
});
