import "server-only";
import { logger } from "@/lib/logger";
import { runAutoReadySweep } from "@/lib/services/simplified-workflow";

/**
 * Runs the simplified-workflow timer (lib/services/simplified-workflow.ts) once a minute inside the long-running
 * Next.js server process (`next start` on Railway). Started once per process from `instrumentation.ts`, never per
 * request and never in a browser, so an order becomes READY with every screen closed — at most one interval after its
 * 10 minutes are up.
 *
 * Several replicas may each run it: the sweep locks each order (`FOR UPDATE SKIP LOCKED`) and compare-and-sets its
 * version, so an order is advanced exactly once. Passes never overlap within a process. Set
 * `ORDER_AUTO_READY_DISABLED=1` to stop it in a process (e.g. a one-off console).
 */
export const AUTO_READY_INTERVAL_MS = 60_000;

const STARTED = Symbol.for("flowdineos.autoReadyScheduler");
type Holder = typeof globalThis & { [STARTED]?: boolean };

export function startAutoReadyScheduler(): void {
  const holder = globalThis as Holder;
  if (holder[STARTED]) return; // Dev hot reload re-runs instrumentation; one timer per process.
  if (process.env.ORDER_AUTO_READY_DISABLED === "1") {
    logger.info("order.auto_ready_scheduler_disabled", {});
    return;
  }
  holder[STARTED] = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runAutoReadySweep();
      if (result.advanced > 0) logger.info("order.auto_ready_sweep", { ...result });
    } catch (error) {
      // A database blip (or a deploy whose migration has not run yet) must never crash the web server.
      logger.warn("order.auto_ready_sweep_failed", { error: String(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), AUTO_READY_INTERVAL_MS);
  timer.unref?.();
  logger.info("order.auto_ready_scheduler_started", { intervalMs: AUTO_READY_INTERVAL_MS });
}
