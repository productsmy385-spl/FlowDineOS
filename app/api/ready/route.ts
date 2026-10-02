import { databaseReady, pendingMigrations } from "@/lib/data/health";
import { logger } from "@/lib/logger";

/**
 * RH-OPS-02 readiness (S1-P26-T003): Railway's health check path. 200 only when PostgreSQL answers within 2 s.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const reachable = await databaseReady(2000);
  if (!reachable) {
    logger.warn("health.not_ready", { dependency: "database" });
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  // A reachable database is not the same as a usable one. Code that needs a table the database has not got yet is
  // not ready to serve, and saying so here means the deploy fails its health check instead of going live and
  // breaking a page for whoever opens it first.
  const pending = await pendingMigrations();
  if (pending.length > 0) {
    logger.error("health.migrations_pending", { pending });
    return Response.json({ status: "unavailable", reason: "MIGRATIONS_PENDING", pending }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ status: "ready" }, { status: 200, headers: { "cache-control": "no-store" } });
}
