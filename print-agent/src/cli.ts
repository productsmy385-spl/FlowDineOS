import os from "node:os";
import { AgentApi, AgentApiError, type FetchLike } from "./api";
import { ConfigError, loadAgentConfig, parseAgentConfig, saveAgentConfig, type AgentConfig } from "./config";
import { CredentialError, FileCredentialStore } from "./credentials";
import { PrintedJournal } from "./journal";
import { createLogger, type Logger } from "./logger";
import { agentPaths, type AgentEnv, type AgentPaths } from "./paths";
import { FatalAgentError, PrintAgentRunner } from "./runner";
import { transportFor } from "./transports";
import { AGENT_VERSION } from "./version";

/**
 * `rasoios-print-agent` commands (S1-P17-T002):
 *
 *   pair <CODE> [--server https://app.example.com]   exchange a pairing code for this PC's token
 *   run                                               claim and print jobs until stopped (the service runs this)
 *   status                                            show the pairing, assigned printers and whether each answers
 *   version
 *
 * Exit codes: 0 ok · 1 error · 2 not paired / token revoked (service managers must not restart-loop on 2).
 */
export const EXIT = { OK: 0, ERROR: 1, NEEDS_PAIRING: 2 } as const;

export type CliIo = { out: (line: string) => void; err: (line: string) => void };
export type CliOptions = { env?: AgentEnv; fetch?: FetchLike; io?: CliIo; signal?: AbortSignal; logger?: Logger };

const USAGE = [
  "Usage:",
  "  rasoios-print-agent pair <CODE> [--server https://your-flowdineos-site]",
  "  rasoios-print-agent run",
  "  rasoios-print-agent status",
  "  rasoios-print-agent version",
].join("\n");

export function osInfo(): string {
  return `${os.type()} ${os.release()} ${os.arch()}`.slice(0, 64);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const io: CliIo = options.io ?? { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) };
  const paths = agentPaths(options.env ?? process.env);
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "pair":
        return await pair(args, paths, io, options);
      case "run":
        return await run(paths, io, options);
      case "status":
        return await status(paths, io, options);
      case "version":
      case "--version":
        io.out(AGENT_VERSION);
        return EXIT.OK;
      default:
        io.err(USAGE);
        return command === undefined || command === "help" || command === "--help" ? EXIT.OK : EXIT.ERROR;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CredentialError) {
      io.err(error.message);
      return EXIT.ERROR;
    }
    throw error;
  }
}

async function pair(args: string[], paths: AgentPaths, io: CliIo, options: CliOptions): Promise<number> {
  const code = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "--server"));
  if (!code) {
    io.err(USAGE);
    return EXIT.ERROR;
  }
  const server = option(args, "--server");
  let config: AgentConfig;
  if (server) {
    config = parseAgentConfig({ serverUrl: server });
    await saveAgentConfig(paths.config, config);
  } else {
    config = await loadAgentConfig(paths.config);
  }

  try {
    const paired = await AgentApi.pair(config.serverUrl, { pairingCode: code, agentVersion: AGENT_VERSION, osInfo: osInfo() }, { fetch: options.fetch });
    await new FileCredentialStore(paths.credentials).save({
      version: 1,
      agentId: paired.agentId,
      token: paired.token,
      serverOrigin: config.serverUrl,
      pairedAt: new Date().toISOString(),
    });
    io.out(`Paired. Agent ${paired.agentId} is connected to ${config.serverUrl}.`);
    io.out(
      paired.printers.length === 0
        ? "No printers are assigned to this agent yet. Assign them in Printing → Printers, then start the service."
        : `${paired.printers.length} printer(s) assigned. Start the service to begin printing.`,
    );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof AgentApiError) {
      // Distinguish a bad code from a network problem without echoing anything the server said (S1-P17-T003).
      if (error.kind === "INVALID_PAIRING_CODE") io.err("That pairing code is not valid or has expired. Create a new code in Printing → Agents and try again.");
      else if (error.kind === "RATE_LIMITED") io.err(`Too many pairing attempts from this network. Wait ${Math.ceil((error.retryAfterMs ?? 900_000) / 60_000)} minute(s) and try again.`);
      else if (error.kind === "NETWORK") io.err("Could not reach the server. Check this PC's internet connection and the server address.");
      else io.err("The server could not complete pairing. Try again in a few minutes.");
      return EXIT.ERROR;
    }
    throw error;
  }
}

async function loadPaired(paths: AgentPaths, io: CliIo) {
  const config = await loadAgentConfig(paths.config);
  const credential = await new FileCredentialStore(paths.credentials).load();
  if (!credential) {
    io.err('This agent is not paired. Run "rasoios-print-agent pair <CODE>".');
    return null;
  }
  if (credential.serverOrigin !== config.serverUrl) {
    // Never send a token to a server other than the one that issued it.
    io.err(`The stored pairing belongs to ${credential.serverOrigin}, but config.json points at ${config.serverUrl}. Pair again for the new server.`);
    return null;
  }
  return { config, credential };
}

async function run(paths: AgentPaths, io: CliIo, options: CliOptions): Promise<number> {
  const paired = await loadPaired(paths, io);
  if (!paired) return EXIT.NEEDS_PAIRING;
  const logger = options.logger ?? createLogger(paired.config.logLevel);
  const journal = new PrintedJournal(paths.journal, logger);
  await journal.load();

  const api = new AgentApi(paired.config.serverUrl, paired.credential.token, { fetch: options.fetch, userAgent: `flowdineos-print-agent/${AGENT_VERSION}` });
  const runner = new PrintAgentRunner({ api, journal, logger, transportFor });

  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runner.run(controller.signal);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof FatalAgentError) {
      logger.error("agent.needs_pairing", { message: error.message });
      io.err(error.message);
      return EXIT.NEEDS_PAIRING;
    }
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function status(paths: AgentPaths, io: CliIo, options: CliOptions): Promise<number> {
  const paired = await loadPaired(paths, io);
  if (!paired) return EXIT.NEEDS_PAIRING;
  io.out(`Agent ${paired.credential.agentId} · version ${AGENT_VERSION} · server ${paired.config.serverUrl}`);

  const api = new AgentApi(paired.config.serverUrl, paired.credential.token, { fetch: options.fetch });
  let config;
  try {
    config = await api.config();
  } catch (error) {
    if (error instanceof AgentApiError && error.kind === "AUTH") {
      io.err("The server rejected this agent's token. It was revoked or replaced — pair the agent again.");
      return EXIT.NEEDS_PAIRING;
    }
    io.err("Could not reach the server.");
    return EXIT.ERROR;
  }
  if (config.printers.length === 0) {
    io.out("No printers are assigned to this agent.");
    return EXIT.OK;
  }
  for (const printer of config.printers) {
    let state = "answers";
    try {
      await transportFor(printer).probe();
    } catch (error) {
      state = `NOT reachable — ${(error as Error).message}`;
    }
    io.out(`- ${printer.name} (${printer.purpose}, ${printer.connectionType} ${printer.connectionAddress}, ${printer.paperWidthMm} mm): ${state}`);
  }
  return EXIT.OK;
}
