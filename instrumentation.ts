// Next.js server boot hook. Validates the environment before any request is served (S1-P01-T004), then starts the
// simplified-workflow timer (owner brief 2026-10-13) — once per server process, never per request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./lib/env");
    assertEnv();
    const { startAutoReadyScheduler } = await import("./lib/jobs/auto-ready-scheduler");
    startAutoReadyScheduler();
  }
}
