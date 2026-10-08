import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where the agent keeps its three files (Q-010, 2026-09-23: Windows and Linux; FlowDineOS branding 2026-10-08).
 *
 * - Windows: `%ProgramData%\FlowDineOS\PrintAgent` — or the existing `%ProgramData%\RasoiOS\PrintAgent` when only that
 *   one exists, so an agent paired before the rename keeps its pairing, token and printed-job journal (no re-pairing,
 *   no duplicate tickets). The installer restricts the folder to SYSTEM and Administrators.
 * - Linux: `/var/lib/flowdineos-print-agent`, or the existing `/var/lib/rasoios-print-agent` likewise.
 *
 * `FLOWDINEOS_AGENT_HOME` (or the older `RASOIOS_AGENT_HOME`) overrides both (development and tests).
 */
export type AgentPaths = { home: string; config: string; credentials: string; journal: string };
export type AgentEnv = Readonly<Record<string, string | undefined>>;

export function agentPaths(env: AgentEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (dir: string) => boolean = existsSync): AgentPaths {
  const override = env.FLOWDINEOS_AGENT_HOME ?? env.RASOIOS_AGENT_HOME;
  const p = override ? path : platform === "win32" ? path.win32 : path.posix;
  let home: string;
  if (override) {
    home = path.resolve(override);
  } else {
    const [current, legacy] =
      platform === "win32"
        ? [p.join(env.ProgramData ?? "C:\\ProgramData", "FlowDineOS", "PrintAgent"), p.join(env.ProgramData ?? "C:\\ProgramData", "RasoiOS", "PrintAgent")]
        : ["/var/lib/flowdineos-print-agent", "/var/lib/rasoios-print-agent"];
    home = !exists(current) && exists(legacy) ? legacy : current;
  }
  return {
    home,
    config: p.join(home, "config.json"),
    credentials: p.join(home, "credentials.json"),
    journal: p.join(home, "journal.json"),
  };
}
