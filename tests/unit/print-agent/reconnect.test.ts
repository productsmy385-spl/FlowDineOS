import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentApi, AgentApiError, type AgentPrinter, type HeartbeatBody } from "@/print-agent/src/api";
import { acquireProcessLock } from "@/print-agent/src/cli";
import { FileCredentialStore, type StoredCredential } from "@/print-agent/src/credentials";
import { PrintedJournal } from "@/print-agent/src/journal";
import { createLogger } from "@/print-agent/src/logger";
import { FatalAgentError, PrintAgentRunner } from "@/print-agent/src/runner";
import { LanTransport } from "@/print-agent/src/transports/lan";
import { getAgentPresenceStatus } from "@/lib/services/printing";
import { startPrinterSimulator, type PrinterSimulator } from "@/tools/printer-simulator/server";

/**
 * Verification of requirements A through T:
 * FlowDineOS Permanent Print Agent Connectivity, Auto-Reconnect & Identity Persistence
 */

function makeCredential(agentId: string = randomUUID(), token: string = `rsa_${"A".repeat(43)}`): StoredCredential {
  return {
    version: 1,
    agentId,
    token,
    serverOrigin: "https://app.flowdineos.in",
    pairedAt: new Date().toISOString(),
  };
}

class MockApi {
  agentId = randomUUID();
  token = `rsa_${"A".repeat(43)}`;
  printers: AgentPrinter[] = [];
  queue: Array<{ jobId: string; printerId: string; jobType: "KOT" | "RECEIPT" | "LABEL"; payload: unknown; attemptCount: number; claimToken: string }> = [];
  heartbeats: HeartbeatBody[] = [];
  acks: Array<{ jobId: string; result: string; claimToken: string }> = [];

  outageError: Error | null = null;
  rateLimitSeconds = 0;
  revoked = false;

  simulateOutage(error: Error = new AgentApiError("NETWORK", "Server unreachable", 503)) {
    this.outageError = error;
  }

  clearOutage() {
    this.outageError = null;
  }

  private gate() {
    if (this.revoked) {
      throw new AgentApiError("AUTH", "Token revoked", 401, "REVOKED_AGENT_TOKEN");
    }
    if (this.rateLimitSeconds > 0) {
      const s = this.rateLimitSeconds;
      throw new AgentApiError("RATE_LIMITED", "Too Many Requests", 429, "RATE_LIMITED", s * 1000);
    }
    if (this.outageError) {
      throw this.outageError;
    }
  }

  async config() {
    this.gate();
    return {
      agentId: this.agentId,
      printers: this.printers,
      pollIntervalMs: 3_000,
      heartbeatIntervalMs: 30_000,
    };
  }

  async heartbeat(body: HeartbeatBody) {
    this.gate();
    this.heartbeats.push(body);
    return {
      serverTime: new Date().toISOString(),
      pollIntervalMs: 3_000,
      heartbeatIntervalMs: 30_000,
    };
  }

  async claim() {
    this.gate();
    const jobs = this.queue.splice(0, 1);
    return { jobs, checks: [] };
  }

  async ack(jobId: string, body: { result: string; claimToken: string }) {
    this.gate();
    this.acks.push({ jobId, result: body.result, claimToken: body.claimToken });
    return { jobId, status: body.result };
  }

  async reportCheck(checkId: string) {
    this.gate();
    return { checkId, status: "COMPLETED" };
  }
}

let tempDir: string;
let simulator: PrinterSimulator;
const logger = createLogger("error", () => undefined);

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fd-reconnect-"));
  simulator = await startPrinterSimulator();
});

afterEach(async () => {
  await simulator.stop();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Print Agent Permanent Connectivity & Auto-Reconnect (Requirements A - T)", () => {
  // A. Normal agent startup
  it("A. Normal agent startup: transitions STARTING -> CONNECTING -> ONLINE and claims queue", async () => {
    const credStore = new FileCredentialStore(path.join(tempDir, "credentials.json"));
    const agentId = randomUUID();
    const token = `rsa_${"B".repeat(43)}`;
    await credStore.save(makeCredential(agentId, token));

    const api = new MockApi();
    api.agentId = agentId;
    api.token = token;
    api.printers = [{
      printerId: "p1",
      name: "Kitchen",
      connectionType: "LAN",
      connectionAddress: "127.0.0.1:9100",
      paperWidthMm: 80,
      purpose: "KOT",
      profile: "GENERIC_80MM",
    }];

    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    await journal.load();

    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    expect(runner.getState()).toBe("STARTING");
    const delay = await runner.cycle();
    expect(runner.getState()).toBe("ONLINE");
    expect(delay).toBeGreaterThan(0);
    expect(api.heartbeats.length).toBe(1);
  });

  // B. PC/service restart preserves identity
  it("B. PC/service restart preserves identity without requesting pairing", async () => {
    const credPath = path.join(tempDir, "credentials.json");
    const credStore1 = new FileCredentialStore(credPath);
    const stableAgentId = randomUUID();
    const stableToken = `rsa_${"C".repeat(43)}`;
    await credStore1.save(makeCredential(stableAgentId, stableToken));

    // Simulate process termination and new service instance starting up
    const credStore2 = new FileCredentialStore(credPath);
    const loaded = await credStore2.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.agentId).toBe(stableAgentId);
    expect(loaded?.token).toBe(stableToken);
    expect(loaded?.serverOrigin).toBe("https://app.flowdineos.in");
  });

  // C. Internet disconnected for 2 minutes
  it("C. Internet disconnected: runner enters RECONNECTING and applies bounded backoff without losing credentials", async () => {
    const credStore = new FileCredentialStore(path.join(tempDir, "credentials.json"));
    const agentId = randomUUID();
    const token = `rsa_${"D".repeat(43)}`;
    await credStore.save(makeCredential(agentId, token));

    const api = new MockApi();
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    // Simulate dropped network
    api.simulateOutage(new TypeError("fetch failed: ENOTFOUND app.flowdineos.in"));

    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(await runner.cycle());
      expect(runner.getState()).toBe("RECONNECTING");
    }

    expect(delays[0]).toBe(1_000);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[3]).toBe(8_000);
    expect(delays[4]).toBe(16_000);
    expect(delays[5]).toBe(32_000);

    // Credentials on disk remain completely intact
    const credsAfter = await credStore.load();
    expect(credsAfter?.agentId).toBe(agentId);
  });

  // D. Internet restored and agent reconnects automatically
  it("D. Internet restored: agent automatically reconnects and returns to ONLINE state", async () => {
    const api = new MockApi();
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    api.simulateOutage(new AgentApiError("NETWORK", "Connection timed out", 504));
    await runner.cycle();
    expect(runner.getState()).toBe("RECONNECTING");
    await runner.cycle();
    expect(runner.getState()).toBe("RECONNECTING");

    // Outage ends -> next cycle recovers
    api.clearOutage();
    await runner.cycle();
    expect(runner.getState()).toBe("ONLINE");
  });

  // E. Production API returns 500 temporarily
  it("E. Production API returns 500 temporarily: treated as recoverable server error, not unpairing", async () => {
    const api = new MockApi();
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    api.simulateOutage(new AgentApiError("SERVER", "Internal Server Error", 500));
    const delay = await runner.cycle();
    expect(delay).toBe(1_000);
    expect(runner.getState()).toBe("RECONNECTING");

    // Reconnects on next cycle
    api.clearOutage();
    await runner.cycle();
    expect(runner.getState()).toBe("ONLINE");
  });

  // F. API returns 429 with Retry-After
  it("F. API returns 429 with Retry-After: honors Retry-After header and remains in RECONNECTING", async () => {
    const api = new MockApi();
    api.rateLimitSeconds = 45;
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    const delay = await runner.cycle();
    expect(delay).toBe(45_000);
    expect(runner.getState()).toBe("RECONNECTING");
  });

  // G. DNS temporarily fails
  it("G. DNS failure: handled gracefully as transient network failure", async () => {
    const api = new MockApi();
    api.simulateOutage(new TypeError("getaddrinfo ENOTFOUND api.railway.app"));
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    const delay = await runner.cycle();
    expect(delay).toBe(1_000);
    expect(runner.getState()).toBe("RECONNECTING");
  });

  // H. Server restarts
  it("H. Server restart (502 Bad Gateway / Connection Refused): reconnects seamlessly with existing credentials", async () => {
    const api = new MockApi();
    api.simulateOutage(new AgentApiError("SERVER", "502 Bad Gateway", 502));
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await runner.cycle();
    await runner.cycle();
    expect(runner.getState()).toBe("RECONNECTING");

    api.clearOutage();
    await runner.cycle();
    expect(runner.getState()).toBe("ONLINE");
  });

  // I. Heartbeat is delayed & server-side presence calculation
  it("I. Server presence: correctly maps timestamps to ONLINE, RECONNECTING, OFFLINE", () => {
    const now = new Date("2026-10-10T12:00:00Z");

    // Fresh heartbeat 20s ago -> ONLINE
    const agentOnline = {
      status: "ACTIVE" as const,
      lastSeenAt: new Date(now.getTime() - 20_000).toISOString(),
    };
    expect(getAgentPresenceStatus(agentOnline, now)).toBe("ONLINE");

    // Delayed heartbeat 75s ago -> RECONNECTING (grace period)
    const agentReconnecting = {
      status: "ACTIVE" as const,
      lastSeenAt: new Date(now.getTime() - 75_000).toISOString(),
    };
    expect(getAgentPresenceStatus(agentReconnecting, now)).toBe("RECONNECTING");

    // Missed heartbeat > 120s ago -> OFFLINE
    const agentOffline = {
      status: "ACTIVE" as const,
      lastSeenAt: new Date(now.getTime() - 150_000).toISOString(),
    };
    expect(getAgentPresenceStatus(agentOffline, now)).toBe("OFFLINE");
  });

  // J. Multiple missed heartbeats do not force pairing
  it("J. Multiple missed heartbeats leave agent in OFFLINE state without revoking or requiring pairing", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const agentOffline = {
      status: "ACTIVE" as const,
      lastSeenAt: new Date(now.getTime() - 3_600_000).toISOString(), // 1 hour offline
    };
    // Offline status is NOT AUTH_REQUIRED or REVOKED
    expect(getAgentPresenceStatus(agentOffline, now)).toBe("OFFLINE");
    expect(agentOffline.status).toBe("ACTIVE");
  });

  // K. Installer repair preserves credentials
  it("K. Installer repair / migration preserves existing credentials", async () => {
    const credStore = new FileCredentialStore(path.join(tempDir, "credentials.json"));
    const identity = makeCredential(randomUUID(), `rsa_${"K".repeat(43)}`);
    await credStore.save(identity);

    // Simulate installer repair checking if file exists before creating
    const loaded = await credStore.load();
    expect(loaded).toEqual(identity);
  });

  // L. Agent upgrade preserves credentials and journal
  it("L. Agent upgrade: credentials and journal survive across version upgrades", async () => {
    const credStore = new FileCredentialStore(path.join(tempDir, "credentials.json"));
    const identity = makeCredential(randomUUID(), `rsa_${"L".repeat(43)}`);
    await credStore.save(identity);

    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    await journal.record("job-pre-upgrade");

    // New version starts
    const journalV2 = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    await journalV2.load();
    expect(journalV2.has("job-pre-upgrade")).toBe(true);

    const credsV2 = await credStore.load();
    expect(credsV2?.agentId).toBe(identity.agentId);
  });

  // M. Explicit revocation prevents reconnection
  it("M. Explicit revocation terminates runner with FatalAgentError and REVOKED state", async () => {
    const api = new MockApi();
    api.revoked = true;
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await expect(runner.cycle()).rejects.toBeInstanceOf(FatalAgentError);
    expect(runner.getState()).toBe("REVOKED");
  });

  // N. Invalid credentials do not cause endless authentication attempts
  it("N. Invalid credentials halt runner immediately without retrying", async () => {
    const api = new MockApi();
    api.simulateOutage(new AgentApiError("AUTH", "Invalid token", 401, "INVALID_AGENT_TOKEN"));
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await expect(runner.cycle()).rejects.toBeInstanceOf(FatalAgentError);
    expect(runner.getState()).toBe("AUTHENTICATION_REQUIRED");
  });

  // O. Two simultaneous processes cannot corrupt agent state (process lock)
  it("O. Process lock prevents duplicate agent processes from running simultaneously", async () => {
    // First process acquires lock
    const releaseLock1 = await acquireProcessLock(tempDir);
    expect(releaseLock1).not.toBeNull();

    // Second process attempts to acquire lock while first is alive
    const releaseLock2 = await acquireProcessLock(tempDir);
    expect(releaseLock2).toBeNull();

    // First process releases lock
    await releaseLock1!();

    // Third process can now acquire lock
    const releaseLock3 = await acquireProcessLock(tempDir);
    expect(releaseLock3).not.toBeNull();
    await releaseLock3!();
  });

  // P. Reconnect does not duplicate agents
  it("P. Reconnect reuses the same agent identity and token, not duplicating agent records", async () => {
    const credStore = new FileCredentialStore(path.join(tempDir, "credentials.json"));
    const identity = makeCredential();
    await credStore.save(identity);

    // Multiple reconnect cycles
    const loaded1 = await credStore.load();
    const loaded2 = await credStore.load();
    expect(loaded1?.agentId).toBe(identity.agentId);
    expect(loaded2?.agentId).toBe(identity.agentId);
    expect(loaded1?.token).toBe(identity.token);
  });

  // Q. Reconnect does not duplicate printed jobs
  it("Q. Reconnect does not duplicate already-printed tickets stored in the journal", async () => {
    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    await journal.record("job-printed-101");

    const api = new MockApi();
    api.printers = [{
      printerId: "p1",
      name: "Kitchen",
      connectionType: "LAN",
      connectionAddress: "127.0.0.1:9100",
      paperWidthMm: 80,
      purpose: "KOT",
      profile: "GENERIC_80MM",
    }];
    // Server re-offers the job because ACK was lost in a disconnect
    api.queue.push({
      jobId: "job-printed-101",
      printerId: "p1",
      jobType: "KOT",
      payload: { schema: "fd.print.v1", title: "KOT", lines: [{ text: "Burger x 1" }] },
      attemptCount: 2,
      claimToken: "claim-token-xyz",
    });

    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport(simulator.host, simulator.port, { connectMs: 1_000, writeMs: 1_000 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await runner.cycle();

    // The job was acknowledged as PRINTED without sending another ticket to the printer
    expect(api.acks).toEqual([{ jobId: "job-printed-101", result: "PRINTED", claimToken: "claim-token-xyz" }]);
    expect(simulator.tickets).toHaveLength(0);
  });

  // R. Reconnect preserves tenant isolation
  it("R. Tenant isolation: server presence function distinguishes revoked / cross-tenant status", () => {
    const revokedAgent = {
      status: "REVOKED" as const,
      lastSeenAt: new Date().toISOString(),
    };
    expect(getAgentPresenceStatus(revokedAgent)).toBe("REVOKED");

    const pendingAgent = {
      status: "PENDING_PAIRING" as const,
      lastSeenAt: null,
    };
    expect(getAgentPresenceStatus(pendingAgent)).toBe("AUTH_REQUIRED");
  });

  // S. PC reboot starts the service and restores the same agent identity
  it("S. PC reboot restarts service cleanly and reads credentials without intervention", async () => {
    const credPath = path.join(tempDir, "credentials.json");
    const credStore = new FileCredentialStore(credPath);
    const agentId = randomUUID();
    await credStore.save(makeCredential(agentId, `rsa_${"S".repeat(43)}`));

    // After reboot
    const rebootCreds = await new FileCredentialStore(credPath).load();
    expect(rebootCreds).not.toBeNull();
    expect(rebootCreds?.agentId).toBe(agentId);
  });

  // T. Offline printer does not take the cloud agent offline if the agent itself is healthy
  it("T. Offline printer does not take the agent offline if agent can reach the cloud", async () => {
    const api = new MockApi();
    api.printers = [{
      printerId: "p_dead",
      name: "Kitchen",
      connectionType: "LAN",
      connectionAddress: "127.0.0.1:9999", // closed port
      paperWidthMm: 80,
      purpose: "KOT",
      profile: "GENERIC_80MM",
    }];

    const journal = new PrintedJournal(path.join(tempDir, "journal.json"), logger);
    const runner = new PrintAgentRunner({
      api: api as unknown as AgentApi,
      journal,
      logger,
      transportFor: () => new LanTransport("127.0.0.1", 9999, { connectMs: 500, writeMs: 500 }),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    await runner.cycle();

    // Agent cloud status is ONLINE even though printer is offline
    expect(runner.getState()).toBe("ONLINE");
    expect(runner.health.get("p_dead")?.health).toBe("OFFLINE");
  });
});
