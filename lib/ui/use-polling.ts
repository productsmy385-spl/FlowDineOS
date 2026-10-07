"use client";

import { useEffect, useRef, useState } from "react";
import { createPoller, type Poller, type PollResult } from "./poller";

/**
 * React wrapper around the cursor poller (S1-P08-T009, ADR-009). Fetches `url?since=<cursor>` with no-store and
 * follows page visibility. Returns `{ stale, lastSuccessAt, refetch }` for `StaleBanner` and post-mutation refreshes.
 *
 * By default the endpoint answers with the poller's own `{ data, cursor }` envelope. Endpoints that answer in their
 * api.md shape instead (the order board and the kitchen board both return `{ …, serverTime, hasMore }`) pass `select`
 * to say which part is the payload and which field is the next cursor.
 */
export function usePolling<T>({
  url,
  intervalMs,
  onData,
  enabled = true,
  select,
  resyncEveryMs,
}: {
  url: string;
  intervalMs: number;
  onData: (data: T, meta: { full: boolean }) => void;
  /** Ask for the whole list this often, so records deleted elsewhere leave the screen too. */
  resyncEveryMs?: number;
  enabled?: boolean;
  select?: (body: unknown) => PollResult<T>;
}) {
  const [stale, setStale] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);
  const pollerRef = useRef<Poller | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    if (!enabled) return;
    const poller = createPoller<T>({
      intervalMs,
      resyncEveryMs,
      fetchPage: async (since) => {
        const target = new URL(url, window.location.origin);
        if (since) target.searchParams.set("since", since);
        const response = await fetch(target, { cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Polling failed with ${response.status}`);
        const body: unknown = await response.json();
        return selectRef.current ? selectRef.current(body) : (body as PollResult<T>);
      },
      onData: (data, meta) => {
        setLastSuccessAt(new Date());
        onDataRef.current(data, meta);
      },
      onStale: (isStale) => setStale(isStale),
    });
    pollerRef.current = poller;
    const onVisibility = () => poller.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    poller.setVisible(document.visibilityState === "visible");
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      poller.stop();
      pollerRef.current = null;
    };
  }, [url, intervalMs, enabled, resyncEveryMs]);

  return { stale, lastSuccessAt, refetch: () => pollerRef.current?.refetch() ?? Promise.resolve() };
}
