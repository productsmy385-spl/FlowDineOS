import { readFile, rename } from "node:fs/promises";
import { writeFileAtomic } from "./fs-atomic";
import type { Logger } from "./logger";

/**
 * Local journal of printed job ids (ADR-007 §5, S1-P17-T004, TC-AGENT-008).
 *
 * Delivery is at-least-once: if the agent prints and then dies before its acknowledgement reaches the server, the lease
 * expires and the job is claimed again. The id is recorded — and fsynced — the moment the printer accepts the bytes and
 * before the acknowledgement is sent, so the re-claimed job is acknowledged without a second ticket. Entries are kept
 * for 24 hours, far longer than any lease.
 */
export const JOURNAL_RETENTION_MS = 24 * 60 * 60 * 1000;

type JournalFile = { version: 1; printed: Record<string, number> };

export class PrintedJournal {
  private readonly printed = new Map<string, number>();
  /** Writes run one after another: printers print in parallel (2026-10-08) and Windows refuses concurrent renames. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const legacyFile = this.file
          .replace("FlowDineOS\\PrintAgent", "RasoiOS\\PrintAgent")
          .replace("FlowDineOS/PrintAgent", "RasoiOS/PrintAgent")
          .replace("flowdineos-print-agent", "rasoios-print-agent");
        if (legacyFile !== this.file) {
          try {
            text = await readFile(legacyFile, "utf8");
          } catch {
            return;
          }
        } else {
          return;
        }
      } else {
        throw error;
      }
    }
    try {
      const parsed = JSON.parse(text) as Partial<JournalFile>;
      if (parsed.version !== 1 || typeof parsed.printed !== "object" || parsed.printed === null) throw new Error("shape");
      for (const [jobId, at] of Object.entries(parsed.printed)) {
        if (typeof at === "number" && Number.isFinite(at)) this.printed.set(jobId, at);
      }
      this.prune();
    } catch {
      // Keep the unreadable file for inspection and start empty rather than refusing to print at all.
      const aside = `${this.file}.corrupt-${this.now()}`;
      await rename(this.file, aside).catch(() => undefined);
      this.logger.error("journal.corrupt", { movedTo: aside });
    }
  }

  has(jobId: string): boolean {
    const at = this.printed.get(jobId);
    return at !== undefined && this.now() - at < JOURNAL_RETENTION_MS;
  }

  async record(jobId: string): Promise<void> {
    this.printed.set(jobId, this.now());
    this.prune();
    // Each queued write saves the whole journal as it is when the write runs, so no entry is lost between writers.
    const write = this.writing
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, JSON.stringify({ version: 1, printed: Object.fromEntries(this.printed) } satisfies JournalFile), 0o600));
    this.writing = write;
    await write;
  }

  get size(): number {
    return this.printed.size;
  }

  private prune(): void {
    const cutoff = this.now() - JOURNAL_RETENTION_MS;
    for (const [jobId, at] of this.printed) if (at < cutoff) this.printed.delete(jobId);
  }
}
