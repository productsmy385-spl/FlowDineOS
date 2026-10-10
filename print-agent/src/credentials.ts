import { readFile, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./fs-atomic";

/**
 * Agent credential storage (S1-P17-T003, SC-PRINT-08, TC-AGENT-007).
 *
 * The token is written to `credentials.json` — never to config.json, never to a log — in a directory only the service
 * account and administrators can read:
 * - Linux: the file is created 0600 inside a 0700 state directory. On load, a file readable by group or others is
 *   refused, because another local user may already have copied the token.
 * - Windows: `%ProgramData%\RasoiOS\PrintAgent` carries an explicit ACL (SYSTEM + Administrators, inheritance removed)
 *   set by the installer. The agent deliberately does not call DPAPI: doing so from Node needs either a native module
 *   or a PowerShell child process, and child processes are banned in this repository (SC-VAL-06). Machine-scope DPAPI
 *   would not keep the token from an administrator anyway, which is the same boundary the ACL enforces.
 *
 * The credential is bound to the server origin it was issued by, so pointing config.json at another server can never
 * make the agent send its token there.
 */
export const storedCredentialSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().uuid(),
    token: z.string().min(20).max(200),
    serverOrigin: z.string().url(),
    pairedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type StoredCredential = z.output<typeof storedCredentialSchema>;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class FileCredentialStore {
  constructor(
    private readonly file: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async load(): Promise<StoredCredential | null> {
    let text: string;
    try {
      if (this.platform !== "win32") {
        const info = await stat(this.file);
        if ((info.mode & 0o077) !== 0) {
          throw new CredentialError(`${this.file} is readable by other users. Remove it and pair the agent again.`);
        }
      }
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const legacyFile = this.file
          .replace("FlowDineOS\\PrintAgent", "RasoiOS\\PrintAgent")
          .replace("FlowDineOS/PrintAgent", "RasoiOS/PrintAgent")
          .replace("flowdineos-print-agent", "rasoios-print-agent");
        if (legacyFile !== this.file) {
          try {
            const legacyText = await readFile(legacyFile, "utf8");
            const raw = JSON.parse(legacyText);
            const parsed = storedCredentialSchema.safeParse(raw);
            if (parsed.success) {
              await this.save(parsed.data).catch(() => undefined);
              return parsed.data;
            }
          } catch {
            // legacy file absent or unreadable
          }
        }
        return null;
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CredentialError("The stored credential is unreadable. Pair the agent again.");
    }
    const parsed = storedCredentialSchema.safeParse(raw);
    if (!parsed.success) throw new CredentialError("The stored credential is invalid. Pair the agent again.");
    return parsed.data;
  }

  /** Replaces any previous credential (re-pairing issues a new token; the old one is revoked on the server side). */
  async save(credential: StoredCredential): Promise<void> {
    const valid = storedCredentialSchema.parse(credential);
    await writeFileAtomic(this.file, `${JSON.stringify(valid)}\n`, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
