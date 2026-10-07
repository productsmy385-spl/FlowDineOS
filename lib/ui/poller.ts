/**
 * Cursor polling controller (S1-P08-T009, ADR-009). Framework-free so its timing rules are unit-tested (TC-DS-014);
 * `usePolling` wraps it for React.
 *
 * - Sends the last cursor as `since`, so the server returns only what changed.
 * - Pauses while the page is hidden; fetches immediately when it becomes visible again.
 * - On failure backs off (interval × 2^misses, capped at 30 s) and reports stale after 3 consecutive misses.
 * - `refetch()` polls now (after a mutation) and never overlaps an in-flight request.
 * - With `resyncEveryMs`, a poll that long after the last full one asks for everything (no `since`) and is passed to
 *   `onData` with `full: true`. A delta only carries rows that changed, never rows that were deleted, so a board needs
 *   this to drop a card whose record is gone (owner bug report 2026-10-07: deleted orders stayed on screen).
 */
export type PollResult<T> = { data: T; cursor: string | null };

export type PollerOptions<T> = {
  fetchPage: (since: string | null) => Promise<PollResult<T>>;
  intervalMs: number;
  onData: (data: T, meta: { full: boolean }) => void;
  resyncEveryMs?: number;
  onStale?: (stale: boolean, lastSuccessAt: Date | null) => void;
  maxBackoffMs?: number;
  staleAfterMisses?: number;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type Poller = {
  start(): void;
  stop(): void;
  refetch(): Promise<void>;
  setVisible(visible: boolean): void;
  readonly state: { since: string | null; misses: number; stale: boolean; nextDelayMs: number | null; lastSuccessAt: Date | null; running: boolean };
};

export function createPoller<T>(options: PollerOptions<T>): Poller {
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const staleAfter = options.staleAfterMisses ?? 3;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const state = { since: null as string | null, misses: 0, stale: false, nextDelayMs: null as number | null, lastSuccessAt: null as Date | null, running: false };
  let visible = true;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let lastFullAt: number | null = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    state.nextDelayMs = null;
  };

  const schedule = (delay: number) => {
    cancel();
    if (!state.running || !visible) return;
    state.nextDelayMs = delay;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, delay);
  };

  const setStale = (stale: boolean) => {
    if (state.stale !== stale) {
      state.stale = stale;
      options.onStale?.(stale, state.lastSuccessAt);
    }
  };

  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const at = now().getTime();
        const full = state.since === null || (options.resyncEveryMs !== undefined && (lastFullAt === null || at - lastFullAt >= options.resyncEveryMs));
        const page = await options.fetchPage(full ? null : state.since);
        if (full) lastFullAt = at;
        state.since = page.cursor ?? state.since;
        state.misses = 0;
        state.lastSuccessAt = now();
        setStale(false);
        options.onData(page.data, { full });
        schedule(options.intervalMs);
      } catch {
        state.misses += 1;
        if (state.misses >= staleAfter) setStale(true);
        schedule(Math.min(options.intervalMs * 2 ** state.misses, maxBackoff));
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    state,
    start() {
      if (state.running) return;
      state.running = true;
      if (visible) void tick();
    },
    stop() {
      state.running = false;
      cancel();
    },
    refetch() {
      if (!state.running) return Promise.resolve();
      cancel();
      return tick();
    },
    setVisible(next: boolean) {
      const wasHidden = !visible;
      visible = next;
      if (!next) cancel();
      else if (wasHidden && state.running) void this.refetch();
    },
  };
}
