import { mkdirSync } from "node:fs";
import path from "node:path";
import { AgentApi, type FetchLike } from "./api";
import { FileCredentialStore, type StoredCredential } from "./credentials";
import { PrintedJournal } from "./journal";
import { createLogger, type Logger } from "./logger";
import { FatalAgentError, PrintAgentRunner, type RunnerState } from "./runner";
import { transportFor } from "./transports";
import { AGENT_VERSION } from "./version";
import { acquireProcessLock } from "./cli";

export type VirtualAgentStatus = RunnerState | "OFFLINE";

export type VirtualAgentOptions = {
  serverUrl?: string;
  homeDir?: string;
  token?: string;
  agentId?: string;
  fetch?: FetchLike;
  logger?: Logger;
  tenantId?: string;
};

export type VirtualAgentHandle = {
  runner: PrintAgentRunner;
  abortController: AbortController;
  promise: Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => VirtualAgentStatus;
  simulateNetworkDrop: (drop: boolean) => void;
};

const DEFAULT_SERVER_URL = process.env.FLOWDINEOS_SERVER_URL ?? "http://localhost:3000";

function resolveVirtualAgentHome(tenantId = "default"): string {
  const dir = path.join(process.cwd(), ".flowdineos", "virtual-agent", tenantId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Pairs a virtual print agent with the server using the existing standard pairing flow (RH-PRINT-02).
 */
export async function pairVirtualAgent(
  serverUrl: string,
  pairingCode: string,
  options: { homeDir?: string; fetch?: FetchLike; agentName?: string } = {},
): Promise<StoredCredential> {
  const home = options.homeDir ?? resolveVirtualAgentHome();
  const paired = await AgentApi.pair(
    serverUrl,
    { pairingCode, agentVersion: `${AGENT_VERSION}-virtual`, osInfo: `FlowDineOS Virtual Agent (${process.platform})` },
    { fetch: options.fetch },
  );

  const credStore = new FileCredentialStore(path.join(home, "credentials.json"));
  const credential: StoredCredential = {
    version: 1,
    agentId: paired.agentId,
    token: paired.token,
    serverOrigin: serverUrl,
    pairedAt: new Date().toISOString(),
  };
  await credStore.save(credential);
  return credential;
}

/**
 * Starts a Virtual Print Agent instance using the exact same PrintAgentRunner, heartbeat, claim, and ack cycle
 * as the physical agent.
 */
export async function startVirtualAgent(options: VirtualAgentOptions = {}): Promise<VirtualAgentHandle> {
  const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
  const home = options.homeDir ?? resolveVirtualAgentHome(options.tenantId);
  const logger = options.logger ?? createLogger("info");
  const abortController = new AbortController();

  let token = options.token;
  if (!token) {
    const credStore = new FileCredentialStore(path.join(home, "credentials.json"));
    const cred = await credStore.load();
    if (!cred) {
      throw new Error(`Virtual Agent at ${home} is not paired. Pair with pairing code first.`);
    }
    token = cred.token;
  }

  // Network drop simulation proxy for fetch
  let networkDropped = false;
  const customFetch: FetchLike = async (url, init) => {
    if (networkDropped) {
      throw new TypeError("Failed to fetch: simulated network drop");
    }
    const realFetch = options.fetch ?? fetch;
    return realFetch(url, init);
  };

  const api = new AgentApi(serverUrl, token, { fetch: customFetch });
  const journal = new PrintedJournal(path.join(home, "journal.json"), logger);

  const runner = new PrintAgentRunner({
    api,
    journal,
    transportFor,
    logger,
  });

  const releaseLock = await acquireProcessLock(home);

  const promise = (async () => {
    try {
      await runner.run(abortController.signal);
    } catch (err) {
      if (err instanceof FatalAgentError) {
        logger.error("virtual_agent.fatal", { message: err.message });
      }
      throw err;
    } finally {
      if (releaseLock) await releaseLock();
    }
  })();

  return {
    runner,
    abortController,
    promise,
    stop: async () => {
      abortController.abort();
      try {
        await promise;
      } catch {
        // Expected cancellation
      }
    },
    getStatus: () => {
      if (abortController.signal.aborted) return "OFFLINE";
      const runnerState = runner.getState();
      return runnerState;
    },
    simulateNetworkDrop: (drop: boolean) => {
      networkDropped = drop;
      logger.info("virtual_agent.network_simulation", { dropped: drop });
    },
  };
}

// ── CLI Execution support ──

if (require.main === module || process.argv[1]?.includes("virtual-agent")) {
  const args = process.argv.slice(2);
  const command = args[0];

  async function cli() {
    const serverUrl = args.find((a) => a.startsWith("--server="))?.split("=")[1] ?? DEFAULT_SERVER_URL;
    const tenantId = args.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? "default";
    const home = resolveVirtualAgentHome(tenantId);

    if (command === "pair") {
      const code = args[1]?.startsWith("--") ? undefined : args[1];
      if (!code) {
        console.error("Usage: tsx print-agent/src/virtual-agent.ts pair <PAIRING_CODE> [--server=http://localhost:3000]");
        process.exit(1);
      }
      console.log(`Pairing Virtual Agent with code ${code} at ${serverUrl}...`);
      const cred = await pairVirtualAgent(serverUrl, code, { homeDir: home });
      console.log(`✓ Paired successfully! Agent ID: ${cred.agentId}`);
      process.exit(0);
    }

    if (command === "run" || !command) {
      console.log(`Starting Virtual Print Agent connected to ${serverUrl}...`);
      const handle = await startVirtualAgent({ serverUrl, homeDir: home, tenantId });
      console.log(`✓ Virtual Print Agent running. Press Ctrl+C to stop.`);
      process.on("SIGINT", async () => {
        console.log("\nStopping Virtual Print Agent...");
        await handle.stop();
        process.exit(0);
      });
      await handle.promise;
    }
  }

  cli().catch((err) => {
    console.error("Virtual Agent Error:", err);
    process.exit(1);
  });
}
