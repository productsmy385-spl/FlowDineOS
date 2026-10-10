import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./fs-atomic";

/**
 * `config.json` (S1-P17-T002, TC-AGENT-011). It holds no secret — the token lives in credentials.json — so it can be
 * read by a technician. Unknown keys are refused so a typo cannot silently disable a setting.
 *
 * The server URL must be HTTPS. Plain HTTP is accepted only for a loopback host (a developer running `next dev` on the
 * same machine), where there is no network for anyone to intercept. A URL carrying a user name, password, query or
 * fragment is refused: only the origin is ever used.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function serverUrlIssue(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Server URL is not a valid URL";
  }
  if (url.username || url.password) return "Server URL must not contain credentials";
  if (url.search || url.hash) return "Server URL must not contain a query or fragment";
  if (url.pathname !== "/" && url.pathname !== "") return "Server URL must be the site origin, e.g. https://app.example.com";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return "Server URL must use https://";
}

export const agentConfigSchema = z
  .object({
    serverUrl: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        const issue = serverUrlIssue(value);
        if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
      })
      .transform((value) => new URL(value).origin),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict();

export type AgentConfig = z.output<typeof agentConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseAgentConfig(raw: unknown): AgentConfig {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
    throw new ConfigError(`Invalid config.json — ${detail}`);
  }
  return parsed.data;
}

export async function loadAgentConfig(file: string): Promise<AgentConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const legacyFile = file
        .replace("FlowDineOS\\PrintAgent", "RasoiOS\\PrintAgent")
        .replace("FlowDineOS/PrintAgent", "RasoiOS/PrintAgent")
        .replace("flowdineos-print-agent", "rasoios-print-agent");
      if (legacyFile !== file) {
        try {
          const legacyText = await readFile(legacyFile, "utf8");
          const config = parseAgentConfig(JSON.parse(legacyText));
          await saveAgentConfig(file, config).catch(() => undefined);
          return config;
        } catch {
          // legacy absent or invalid
        }
      }
      throw new ConfigError(`No config.json at ${file}. Run "rasoios-print-agent pair <code> --server https://…" first.`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config.json at ${file} is not valid JSON`);
  }
  return parseAgentConfig(raw);
}

export async function saveAgentConfig(file: string, config: AgentConfig): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o644);
}
