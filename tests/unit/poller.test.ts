import { describe, expect, it, vi } from "vitest";
import { createPoller } from "@/lib/ui/poller";

// TC-DS-014 — polling pauses when hidden, resumes immediately, backs off on failure and flags stale after 3 misses
// (S1-P08-T009, ADR-009).
function harness(responses: Array<"ok" | "fail">) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sinces: Array<string | null> = [];
  let call = 0;
  const staleEvents: boolean[] = [];
  const data: number[] = [];
  const poller = createPoller<number>({
    intervalMs: 3000,
    fetchPage: async (since) => {
      sinces.push(since);
      const outcome = responses[Math.min(call, responses.length - 1)];
      call++;
      if (outcome === "fail") throw new Error("network");
      return { data: call, cursor: `c${call}` };
    },
    onData: (d) => data.push(d),
    onStale: (s) => staleEvents.push(s),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      timers[h as number] = { fn: () => {}, ms: -1 };
    },
  });
  const fireNext = async () => {
    const next = timers.find((t) => t.ms >= 0);
    if (!next) throw new Error("no timer scheduled");
    next.ms = -1;
    next.fn();
    await vi.waitFor(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { poller, timers, sinces, staleEvents, data, fireNext, calls: () => call };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TC-DS-014 polling controller", () => {
  it("polls with the last cursor as `since` on the normal interval", async () => {
    const h = harness(["ok"]);
    h.poller.start();
    await flush();
    expect(h.sinces).toEqual([null]);
    expect(h.poller.state.nextDelayMs).toBe(3000);
    await h.fireNext();
    expect(h.sinces).toEqual([null, "c1"]);
    expect(h.data).toEqual([1, 2]);
  });

  it("pauses while hidden and fetches immediately when visible again", async () => {
    const h = harness(["ok"]);
    h.poller.start();
    await flush();
    h.poller.setVisible(false);
    expect(h.poller.state.nextDelayMs).toBeNull();
    expect(h.timers.every((t) => t.ms < 0)).toBe(true);
    h.poller.setVisible(true);
    await flush();
    expect(h.calls()).toBe(2);
    expect(h.poller.state.nextDelayMs).toBe(3000);
  });

  it("backs off on failure (6 s, 12 s, 24 s, capped at 30 s) and flags stale after 3 misses", async () => {
    const h = harness(["fail"]);
    h.poller.start();
    await flush();
    expect(h.poller.state.nextDelayMs).toBe(6000);
    await h.fireNext();
    expect(h.poller.state.nextDelayMs).toBe(12000);
    expect(h.poller.state.stale).toBe(false);
    await h.fireNext();
    expect(h.poller.state.nextDelayMs).toBe(24000);
    expect(h.poller.state.stale).toBe(true);
    await h.fireNext();
    expect(h.poller.state.nextDelayMs).toBe(30000);
    expect(h.staleEvents).toEqual([true]);
  });

  it("clears stale and returns to the normal interval after a success", async () => {
    const h = harness(["fail", "fail", "fail", "ok"]);
    h.poller.start();
    await flush();
    await h.fireNext();
    await h.fireNext();
    expect(h.poller.state.stale).toBe(true);
    await h.fireNext();
    expect(h.poller.state.stale).toBe(false);
    expect(h.poller.state.misses).toBe(0);
    expect(h.poller.state.nextDelayMs).toBe(3000);
    expect(h.staleEvents).toEqual([true, false]);
  });

  it("refetch polls now without overlapping an in-flight request, and stop cancels everything", async () => {
    const h = harness(["ok"]);
    h.poller.start();
    const a = h.poller.refetch();
    const b = h.poller.refetch();
    await Promise.all([a, b]);
    expect(h.calls()).toBe(1);
    await h.poller.refetch();
    expect(h.calls()).toBe(2);
    h.poller.stop();
    expect(h.poller.state.nextDelayMs).toBeNull();
    await h.poller.refetch();
    expect(h.calls()).toBe(2);
  });

  it("with resyncEveryMs, asks for everything again once that long has passed and says the page is full", async () => {
    let clock = 0;
    const sinces: Array<string | null> = [];
    const metas: boolean[] = [];
    const timers: Array<() => void> = [];
    let call = 0;
    const poller = createPoller<number>({
      intervalMs: 10_000,
      resyncEveryMs: 60_000,
      now: () => new Date(clock),
      fetchPage: async (since) => {
        sinces.push(since);
        call++;
        return { data: call, cursor: `c${call}` };
      },
      onData: (_d, meta) => metas.push(meta.full),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    poller.start();
    await flush();
    for (const at of [10_000, 20_000, 60_000, 70_000]) {
      clock = at;
      timers.shift()!();
      await flush();
    }
    expect(sinces).toEqual([null, "c1", "c2", null, "c4"]);
    expect(metas).toEqual([true, false, false, true, false]);
  });
});
