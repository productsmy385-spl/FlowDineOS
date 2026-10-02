import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/ready/route";
import { databaseReady, pendingMigrations } from "@/lib/data/health";
import { testDb } from "../setup/db";

/**
 * TC-OPS-010 — readiness notices a database that is reachable but behind the code (RASOIOS-ADR-001).
 *
 * The staff daily-password release went live on 2026-10-02 with `0005_staff_daily_login` unapplied: the process was
 * healthy, `SELECT 1` answered, and the first administrator to open the page got "Something went wrong". The health
 * check is the right place to catch that, because a failing one stops the deployment instead of the user finding it.
 */
const db = testDb();

describe("TC-OPS-010 readiness", () => {
  it("reports ready when the database is reachable and fully migrated", async () => {
    expect(await databaseReady(5000, db)).toBe(true);
    expect(await pendingMigrations(db)).toEqual([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("names the migrations the database is missing", async () => {
    // A database that knows about nothing: every migration on disk is pending.
    const emptyLedger = { $queryRaw: async () => [] } as unknown as Parameters<typeof pendingMigrations>[0];
    const pending = await pendingMigrations(emptyLedger);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending).toContain("0005_staff_daily_login");
    // Sorted, so a human reads them in the order they would be applied.
    expect([...pending].sort()).toEqual(pending);
  });

  it("fails open when it cannot read the ledger, rather than refusing a healthy deployment on a guess", async () => {
    const broken = {
      $queryRaw: async () => {
        throw new Error("relation \"_prisma_migrations\" does not exist");
      },
    } as unknown as Parameters<typeof pendingMigrations>[0];
    expect(await pendingMigrations(broken)).toEqual([]);
  });

  it("still reports unavailable when the database cannot be reached at all", async () => {
    const unreachable = {
      $queryRaw: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Parameters<typeof databaseReady>[1];
    expect(await databaseReady(1000, unreachable)).toBe(false);
  });
});
