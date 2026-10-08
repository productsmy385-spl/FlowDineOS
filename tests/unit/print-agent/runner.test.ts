import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentApiError, type AckBody, type AgentApiLike, type AgentPrinter, type ClaimedJob, type HeartbeatBody, type PrinterCheckReport, type PrinterCheckRequest } from "@/print-agent/src/api";
import { PrintedJournal } from "@/print-agent/src/journal";
import { createLogger } from "@/print-agent/src/logger";
import { FatalAgentError, IDLE_POLL_MS, MAX_NETWORK_BACKOFF_MS, PrintAgentRunner } from "@/print-agent/src/runner";
import { LanTransport } from "@/print-agent/src/transports/lan";
import { printedText, decodeEscPos } from "@/tools/printer-simulator/decode";
import { startPrinterSimulator, type PrinterSimulator } from "@/tools/printer-simulator/server";

/**
 * The claim loop against a scripted server and the TCP printer simulator — TC-AGENT-008 (no second ticket after a
 * crash before the acknowledgement) and TC-AGENT-012 (server outage, backoff, resume in order). S1-P17-T004.
 */
const printer: AgentPrinter = {
  printerId: randomUUID(),
  name: "Kitchen Printer",
  purpose: "KOT",
  connectionType: "LAN",
  connectionAddress: "192.168.1.50:9100",
  paperWidthMm: 80,
};

const ticket = (label: string) => ({ version: 1, widthMm: 80, blocks: [{ type: "text", text: label }, { type: "cut" }] });

function job(label: string, overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    jobId: randomUUID(),
    claimToken: randomUUID(),
    printerId: printer.printerId,
    jobType: "KOT",
    payload: ticket(label),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    attemptCount: 1,
    ...overrides,
  };
}

class ScriptedServer implements AgentApiLike {
  queue: ClaimedJob[] = [];
  acks: Array<{ jobId: string } & AckBody> = [];
  heartbeats: HeartbeatBody[] = [];
  /** Number of upcoming calls that fail as if the network were down. */
  outage = 0;
  revoked = false;
  printers: AgentPrinter[] = [printer];
  checks: PrinterCheckRequest[] = [];
  checkReports: Array<{ checkId: string } & PrinterCheckReport> = [];
  /** Jobs per claim: the real server gives at most one per printer (lib/data/printing.ts claimJobs). */
  perClaim = 1;

  private gate() {
    if (this.revoked) throw new AgentApiError("AUTH", "revoked", 401, "INVALID_AGENT_TOKEN");
    if (this.outage > 0) {
      this.outage -= 1;
      throw new AgentApiError("NETWORK", "down");
    }
  }
  async config() {
    this.gate();
    return { agentId: randomUUID(), printers: this.printers, pollIntervalMs: 3_000, heartbeatIntervalMs: 30_000 };
  }
  async heartbeat(body: HeartbeatBody) {
    this.gate();
    this.heartbeats.push(body);
    return { serverTime: new Date().toISOString(), pollIntervalMs: 3_000, heartbeatIntervalMs: 30_000 };
  }
  async claim() {
    this.gate();
    return { jobs: this.queue.splice(0, this.perClaim), checks: this.checks.splice(0) };
  }
  async reportCheck(checkId: string, report: PrinterCheckReport) {
    this.gate();
    this.checkReports.push({ checkId, ...report });
    return { checkId, status: "COMPLETED" };
  }
  async ack(jobId: string, body: AckBody) {
    this.gate();
    this.acks.push({ jobId, ...body });
    return { jobId, status: body.result };
  }
}

let simulator: PrinterSimulator;
let dir: string;
let server: ScriptedServer;
const logger = createLogger("error", () => undefined);

async function newRunner(journal?: PrintedJournal) {
  const j = journal ?? new PrintedJournal(path.join(dir, "journal.json"), logger);
  await j.load();
  // The printer row says 192.168.1.50; in the test every printer is the local simulator.
  const runner = new PrintAgentRunner({
    api: server,
    journal: j,
    logger,
    transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { runner, journal: j };
}

beforeEach(async () => {
  simulator = await startPrinterSimulator();
  dir = await mkdtemp(path.join(os.tmpdir(), "rasoios-runner-"));
  server = new ScriptedServer();
});
afterEach(async () => {
  await simulator.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("happy path", () => {
  it("prints, journals, acknowledges PRINTED and reports the printer ONLINE", async () => {
    const { runner, journal } = await newRunner();
    const kot = job("KOT #1024");
    server.queue.push(kot);

    expect(await runner.cycle()).toBe(0); // a job came back → claim again immediately
    expect(printedText(decodeEscPos((await simulator.waitForTickets(1))[0]!))).toEqual(["KOT #1024"]);
    expect(server.acks).toEqual([{ jobId: kot.jobId, claimToken: kot.claimToken, result: "PRINTED" }]);
    expect(journal.has(kot.jobId)).toBe(true);
    expect(server.heartbeats[0]!.printers).toEqual([{ printerId: printer.printerId, health: "ONLINE" }]);
  });

  it("empty queue: poll interval with jitter, then idle backoff after 10 empty polls", async () => {
    const { runner } = await newRunner();
    expect(await runner.cycle()).toBe(3_000);
    for (let i = 0; i < 8; i++) await runner.cycle();
    expect(await runner.cycle()).toBe(IDLE_POLL_MS);
  });
});

describe("TC-AGENT-008 crash after printing, before the acknowledgement", () => {
  it("the re-claimed job is acknowledged without a second ticket", async () => {
    const kot = job("KOT #7");
    // First life: prints, then the acknowledgement never gets through (process dies / network drops).
    const first = await newRunner();
    server.queue.push(kot);
    const realAck = server.ack.bind(server);
    server.ack = async () => {
      throw new AgentApiError("NETWORK", "down");
    };
    await first.runner.cycle();
    expect(simulator.tickets).toHaveLength(1);
    expect(server.acks).toHaveLength(0);

    // Lease expires; the server hands the same job out again with a new claim token. A fresh process starts.
    server.ack = realAck;
    const reclaimed = { ...kot, claimToken: randomUUID(), attemptCount: 2 };
    server.queue.push(reclaimed);
    const second = await newRunner(new PrintedJournal(path.join(dir, "journal.json"), logger));
    await second.runner.cycle();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(simulator.tickets).toHaveLength(1);
    expect(server.acks).toEqual([{ jobId: kot.jobId, claimToken: reclaimed.claimToken, result: "PRINTED" }]);
  });
});

describe("TC-AGENT-012 server unreachable", () => {
  it("backs off exponentially to 60 s, then resumes and prints the queue in order", async () => {
    const { runner } = await newRunner();
    server.queue.push(job("first"), job("second"), job("third"));
    server.outage = 12;

    const delays: number[] = [];
    while (server.outage > 0) delays.push(await runner.cycle());
    expect(delays.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, MAX_NETWORK_BACKOFF_MS]);
    expect(Math.max(...delays)).toBe(MAX_NETWORK_BACKOFF_MS);

    while (server.queue.length > 0) await runner.cycle();
    const tickets = await simulator.waitForTickets(3);
    expect(tickets.map((t) => printedText(decodeEscPos(t))[0])).toEqual(["first", "second", "third"]);
    expect(server.acks.map((a) => a.result)).toEqual(["PRINTED", "PRINTED", "PRINTED"]);
  });
});

describe("failures are reported, never hidden", () => {
  it("printer switched off → FAILED with CONNECTION_REFUSED and health OFFLINE; nothing journaled", async () => {
    const { runner, journal } = await newRunner();
    await simulator.setMode("offline");
    const kot = job("KOT #9");
    server.queue.push(kot);
    await runner.cycle();

    expect(server.acks[0]).toMatchObject({ jobId: kot.jobId, result: "FAILED", errorCode: "CONNECTION_REFUSED" });
    expect(runner.health.get(printer.printerId)?.health).toBe("OFFLINE");
    expect(journal.has(kot.jobId)).toBe(false);
    expect(server.heartbeats[0]!.printers[0]).toMatchObject({ health: "OFFLINE" });
  });

  it("a payload that is not a PrintDocument is FAILED as ESC_POS_RENDER_FAILED and never sent to the printer", async () => {
    const { runner } = await newRunner();
    server.queue.push(job("x", { payload: { version: 1, widthMm: 80, blocks: [{ type: "raw", bytes: "1b70" }] } }));
    await runner.cycle();
    expect(server.acks[0]).toMatchObject({ result: "FAILED", errorCode: "ESC_POS_RENDER_FAILED" });
    expect(simulator.tickets).toHaveLength(0);
  });

  it("a job for a printer not assigned to this agent is FAILED as PRINTER_NOT_FOUND", async () => {
    const { runner } = await newRunner();
    server.queue.push(job("x", { printerId: randomUUID() }));
    await runner.cycle();
    expect(server.acks[0]).toMatchObject({ result: "FAILED", errorCode: "PRINTER_NOT_FOUND" });
    expect(simulator.tickets).toHaveLength(0);
  });

  it("a revoked token stops the agent (FatalAgentError), it does not retry forever", async () => {
    const { runner } = await newRunner();
    server.revoked = true;
    await expect(runner.cycle()).rejects.toBeInstanceOf(FatalAgentError);
  });

  it("run() exits cleanly when stopped", async () => {
    const { runner } = await newRunner();
    const controller = new AbortController();
    const running = runner.run(controller.signal);
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });
});

describe("printing hardening 2026-10-08", () => {
  it("Test connection: the agent connects and closes, reports the result, and prints nothing", async () => {
    const { runner } = await newRunner();
    const checkId = randomUUID();
    server.checks.push({ checkId, printerId: printer.printerId });
    await runner.cycle();
    expect(server.checkReports).toEqual([expect.objectContaining({ checkId, ok: true })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(simulator.tickets).toHaveLength(0);

    await simulator.setMode("offline");
    const failingId = randomUUID();
    server.checks.push({ checkId: failingId, printerId: printer.printerId });
    await runner.cycle();
    expect(server.checkReports[1]).toMatchObject({ checkId: failingId, ok: false, errorCode: "CONNECTION_REFUSED" });
    expect(runner.health.get(printer.printerId)?.health).toBe("OFFLINE");
  });

  it("a check for a printer this agent does not own is reported as PRINTER_NOT_FOUND", async () => {
    const { runner } = await newRunner();
    server.checks.push({ checkId: randomUUID(), printerId: randomUUID() });
    await runner.cycle();
    expect(server.checkReports[0]).toMatchObject({ ok: false, errorCode: "PRINTER_NOT_FOUND" });
  });

  it("one lane per printer: an unreachable kitchen printer does not hold up the bar printer's ticket", async () => {
    const bar: AgentPrinter = { ...printer, printerId: randomUUID(), name: "Bar Printer", connectionAddress: "192.168.1.51:9100" };
    server.printers = [printer, bar];
    server.perClaim = 2;
    const j = new PrintedJournal(path.join(dir, "journal.json"), logger);
    await j.load();
    const runner = new PrintAgentRunner({
      api: server,
      journal: j,
      logger,
      // The kitchen printer never answers (TEST-NET-1 is never routed); the bar printer is the simulator.
      transportFor: (p) => (p.printerId === printer.printerId ? new LanTransport("192.0.2.1", 9100, { connectMs: 1_500, writeMs: 500 }) : new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 })),
      sleep: async () => undefined,
      random: () => 0.5,
    });
    await runner.heartbeat();
    const kitchenJob = job("KOT #1 kitchen");
    const barJob = job("KOT #2 bar", { printerId: bar.printerId });
    server.queue.push(kitchenJob, barJob);

    const barPrinted = simulator.waitForTickets(1);
    const started = Date.now();
    const cycle = runner.cycle();
    await barPrinted;
    // The bar ticket came out while the kitchen printer was still timing out.
    expect(Date.now() - started).toBeLessThan(1_400);
    await cycle;
    expect(server.acks.find((a) => a.jobId === barJob.jobId)).toMatchObject({ result: "PRINTED" });
    expect(server.acks.find((a) => a.jobId === kitchenJob.jobId)).toMatchObject({ result: "FAILED" });
  });
});
