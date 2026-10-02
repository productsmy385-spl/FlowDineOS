import "server-only";
import { db } from "@/lib/db/prisma";

/**
 * Readiness probe (RH-OPS-02, S1-P26-T003): `SELECT 1` must answer within `timeoutMs`. Returns a boolean only —
 * no error text, host or version ever leaves this function.
 */
export async function databaseReady(timeoutMs = 2000, client: { $queryRaw: typeof db.$queryRaw } = db): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = client.$queryRaw`SELECT 1`.then(() => true);
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([probe, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Migrations that exist in the repository but have not been applied to the database.
 *
 * A deployment can ship code that needs a table its database does not have yet: on 2026-10-02 the staff
 * daily-password release went live while `0005_staff_daily_login` was still unapplied, and the first person to open
 * the page got "Something went wrong" — the process was perfectly healthy, it just could not answer. `SELECT 1`
 * cannot see that, so readiness now compares the two lists.
 *
 * Fails *open* on anything it cannot establish. If the migrations directory is not readable — a bundler that did
 * not trace it, a serverless filesystem — this returns an empty list and readiness is unchanged. It only ever
 * reports drift it has positive evidence for, so the worst case is the behaviour we had before, never a healthy
 * deployment refused on a guess.
 */
export async function pendingMigrations(client: { $queryRaw: typeof db.$queryRaw } = db): Promise<string[]> {
  let onDisk: string[];
  try {
    const { readdirSync } = await import("node:fs");
    const path = await import("node:path");
    onDisk = readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  if (onDisk.length === 0) return [];

  try {
    const rows = await client.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const applied = new Set(rows.map((row) => row.migration_name));
    return onDisk.filter((name) => !applied.has(name)).sort();
  } catch {
    // No `_prisma_migrations` table, or the query failed: `databaseReady` is the check for that, not this one.
    return [];
  }
}
