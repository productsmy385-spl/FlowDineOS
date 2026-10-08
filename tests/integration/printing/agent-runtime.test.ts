import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as configRoute } from "@/app/api/v1/print-agent/config/route";
import { POST as heartbeatRoute } from "@/app/api/v1/print-agent/heartbeat/route";
import { POST as ackRoute } from "@/app/api/v1/print-agent/jobs/[jobId]/ack/route";
import { POST as claimRoute } from "@/app/api/v1/print-agent/jobs/claim/route";
import { POST as pairRoute } from "@/app/api/v1/print-agent/pair/route";
import { createStaffOrderAction, updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { createPrintAgentPairingAction, createTestPrintJobAction, printReceiptAction, revokePrintAgentAction, updatePrinterAction } from "@/app/restaurant/printing/actions";
import { AgentApi, type AgentPrinter, type FetchLike } from "@/print-agent/src/api";
import { PrintedJournal } from "@/print-agent/src/journal";
import { createLogger } from "@/print-agent/src/logger";
import { FatalAgentError, PrintAgentRunner } from "@/print-agent/src/runner";
import { LanTransport } from "@/print-agent/src/transports/lan";
import { decodeEscPos, printedText } from "@/tools/printer-simulator/decode";
import { startPrinterSimulator, type PrinterSimulator } from "@/tools/printer-simulator/server";
import { asSeedUser, invokeAction, seedOnce, seeded, tenantIdOf } from "../helpers/actors";
import { testDb } from "../setup/db";
import { activeAgent, clearJobs, dataOf, testPrinter, TRUSTED_HOPS_FOR_TESTS, type RouteHandler } from "./helpers";

/**
 * TC-AGENT-009 (integration form) — the whole chain with the real agent code (S1-P17-T008):
 *
 *   console action → PRINT_JOB → RH-AGT route handlers (real auth, real lease SQL) → print-agent runner
 *   → ESC/POS encoder → TCP → printer simulator → acknowledgement → PRINTED in the database.
 *
 * The agent's HTTP client is pointed at the route handlers in-process instead of a network socket; everything after
 * `fetch` is production code. Printers keep their real 192.168.x addresses in the database; only the last hop (TCP
 * to the simulator) is redirected, and the test asserts which configured address the agent was asked to print to.
 */
const db = testDb();
const A = tenantIdOf("A");
const KITCHEN_PRINTER = seeded("A", "printer:kitchen");
const COUNTER_PRINTER = seeded("A", "printer:counter");
const ITEM = { chai: seeded("A", "item:masala-chai"), chicken65: seeded("A", "item:chicken-65") };

const ROUTES: Array<[RegExp, RouteHandler, (m: RegExpExecArray) => Record<string, string>]> = [
  [/^\/api\/v1\/print-agent\/pair$/, pairRoute as unknown as RouteHandler, () => ({})],
  [/^\/api\/v1\/print-agent\/config$/, configRoute as unknown as RouteHandler, () => ({})],
  [/^\/api\/v1\/print-agent\/heartbeat$/, heartbeatRoute as unknown as RouteHandler, () => ({})],
  [/^\/api\/v1\/print-agent\/jobs\/claim$/, claimRoute as unknown as RouteHandler, () => ({})],
  [/^\/api\/v1\/print-agent\/jobs\/([0-9a-f-]{36})\/ack$/, ackRoute as unknown as RouteHandler, (m) => ({ jobId: m[1]! })],
];

/** `fetch` that dispatches to the Next.js route handlers, as the deployed app would after TLS termination. */
const inProcessFetch: FetchLike = async (input, init) => {
  const url = new URL(input);
  for (const [pattern, handler, params] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", `10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);
    const request = new NextRequest(url, { method: init.method, headers, body: init.body as string | undefined });
    return handler(request, { params: Promise.resolve(params(match)) });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
};

let simulator: PrinterSimulator;
let dir: string;
let agentId: string;
let token: string;
const targets: string[] = [];

beforeAll(async () => {
  await seedOnce();
  simulator = await startPrinterSimulator();
}, 120_000);
afterAll(async () => {
  await simulator.stop();
});
beforeEach(async () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", TRUSTED_HOPS_FOR_TESTS);
  dir = await mkdtemp(path.join(os.tmpdir(), "rasoios-agent-it-"));
  targets.length = 0;
  simulator.tickets.length = 0;
  await clearJobs("A");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function runnerFor(agentToken: string) {
  const logger = createLogger("error", () => undefined);
  const api = new AgentApi("https://app.rasoios.test", agentToken, { fetch: inProcessFetch });
  return new PrintAgentRunner({
    api,
    journal: new PrintedJournal(path.join(dir, "journal.json"), logger),
    logger,
    transportFor: (printer: AgentPrinter) => {
      targets.push(`${printer.name}@${printer.connectionAddress}`);
      return new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 2_000 });
    },
    sleep: async () => undefined,
  });
}

async function drain(runner: PrintAgentRunner, maxCycles = 20) {
  for (let i = 0; i < maxCycles; i++) if ((await runner.cycle()) !== 0) return;
}

describe("TC-AGENT-009 pair → assign → print → PRINTED", () => {
  it("pairs through the real endpoint and prints KOT, receipt and test page on the assigned printers", async () => {
    // 1. Tenant admin creates a pairing code in the console; the agent exchanges it (RH-AGT-01).
    await asSeedUser("A", "TENANT_ADMIN");
    const issued = dataOf(await invokeAction(createPrintAgentPairingAction, { name: `Runtime PC ${randomUUID().slice(0, 6)}` }));
    const paired = await AgentApi.pair("https://app.rasoios.test", { pairingCode: issued.pairingCode.toLowerCase(), agentVersion: "0.1.0", osInfo: "Windows_NT 10.0 x64" }, { fetch: inProcessFetch });
    expect(paired.agentId).toBe(issued.agentId);
    agentId = paired.agentId;
    token = paired.token;

    // 2. Admin assigns the kitchen (KOT) and counter (RECEIPT) printers to this agent.
    for (const printerId of [KITCHEN_PRINTER, COUNTER_PRINTER]) dataOf(await invokeAction(updatePrinterAction, { printerId, printAgentId: agentId }));

    // 3. A cashier takes and accepts an order → KOT job; a manager prints the bill → RECEIPT job.
    await asSeedUser("A", "CASHIER");
    const order = dataOf(
      await invokeAction(createStaffOrderAction, {
        idempotencyKey: randomUUID(),
        orderType: "DINE_IN",
        tableLabel: "T2",
        items: [{ menuItemId: ITEM.chicken65, quantity: 2, specialInstructions: "Less spicy" }],
      } as never),
    ).order;
    dataOf(await invokeAction(updateOrderStatusAction, { orderId: order.id, status: "ACCEPTED" }));
    await asSeedUser("A", "MANAGER");
    const receipt = dataOf(await invokeAction(printReceiptAction, { orderId: order.id }));
    await asSeedUser("A", "TENANT_ADMIN");
    const testPage = dataOf(await invokeAction(createTestPrintJobAction, { printerId: KITCHEN_PRINTER }));

    const kotJob = await db.printJob.findFirstOrThrow({ where: { tenantId: A, jobType: "KOT", kotTicket: { orderId: order.id } } });
    expect(kotJob.status).toBe("PENDING");

    // 4. The agent heartbeats, claims and prints until the queue is empty.
    const runner = runnerFor(token);
    await drain(runner);

    const jobs = await db.printJob.findMany({ where: { id: { in: [kotJob.id, receipt.id, testPage.id] } } });
    expect(jobs.map((j) => j.status)).toEqual(["PRINTED", "PRINTED", "PRINTED"]);
    for (const job of jobs) expect(job).toMatchObject({ printAgentId: agentId, attemptCount: 1 });

    // 5. What came out of the "printer": the kitchen ticket (no money), the customer bill (with money), the test page.
    const tickets = (await simulator.waitForTickets(3)).map((bytes) => decodeEscPos(bytes));
    for (const ticket of tickets) expect(ticket.unknown).toEqual([]);
    const texts = tickets.map((ticket) => printedText(ticket).join("\n"));
    const kotText = texts.find((text) => text.includes("Chicken 65") && !text.includes("TOTAL"))!;
    expect(kotText).toContain("Less spicy");
    expect(kotText).not.toMatch(/Rs|INR/);
    const billText = texts.find((text) => text.includes("TOTAL"))!;
    expect(billText).toContain(order.orderNumber);
    expect(texts.some((text) => text.includes("PRINTER TEST"))).toBe(true);

    // The agent was told to print to the configured LAN addresses of the right printers.
    const printers = await db.printer.findMany({ where: { id: { in: [KITCHEN_PRINTER, COUNTER_PRINTER] } } });
    for (const printer of printers) expect(targets).toContain(`${printer.name}@${printer.connectionAddress}`);

    // 6. Health is what the agent measured, not assumed.
    const kitchen = await db.printer.findUniqueOrThrow({ where: { id: KITCHEN_PRINTER } });
    expect(kitchen.health).toBe("ONLINE");
  });

  it("a printer that is switched off shows FAILED/retry and OFFLINE — never PRINTED", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const job = dataOf(await invokeAction(createTestPrintJobAction, { printerId: KITCHEN_PRINTER }));
    await simulator.setMode("offline");
    try {
      await runnerFor(token).cycle();
    } finally {
      await simulator.setMode("normal");
    }
    const row = await db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("PENDING"); // retry scheduled by the job type's policy (lib/print/state-machine.ts)
    expect(row).toMatchObject({ attemptCount: 1, lastErrorCode: "CONNECTION_REFUSED", printedAt: null });
    expect((await db.printer.findUniqueOrThrow({ where: { id: KITCHEN_PRINTER } })).lastErrorCode).toBe("CONNECTION_REFUSED");
    expect((await db.printer.findUniqueOrThrow({ where: { id: KITCHEN_PRINTER } })).health).toBe("OFFLINE");
    expect(simulator.tickets).toHaveLength(0);
  });

  it("tenant isolation: another tenant's agent never receives these jobs", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    const job = dataOf(await invokeAction(createTestPrintJobAction, { printerId: KITCHEN_PRINTER }));

    const other = await activeAgent("B", { name: "Other restaurant PC" });
    const bPrinter = await testPrinter("B", { agentId: other.agentId, purpose: "KOT" });
    const runner = runnerFor(other.token);
    await drain(runner);

    expect([...runner.printers.keys()]).toEqual([bPrinter.id]);
    expect((await db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("PENDING");
    expect(simulator.tickets).toHaveLength(0);
  });

  it("revoking the agent in the console stops it on its next call", async () => {
    await asSeedUser("A", "TENANT_ADMIN");
    dataOf(await invokeAction(revokePrintAgentAction, { agentId }));
    await expect(runnerFor(token).cycle()).rejects.toBeInstanceOf(FatalAgentError);
  });
});
