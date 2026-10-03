import { describe, expect, it } from "vitest";
import { isLate, LATE_AFTER_MINUTES, minutesSince, sectionLoads } from "@/lib/ui/kitchen-load";

// TC-DASH-010 — the dashboard's station radar counts real tickets and nothing else (RASOIOS-ADR-020).
const NOW = new Date("2026-10-03T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const SOUTH = { id: "s1", name: "South Indian" };
const BEV = { id: "s2", name: "Beverages" };

describe("TC-DASH-010 kitchen load per section", () => {
  it("counts active and late tickets per section, and keeps an idle section visible", () => {
    const loads = sectionLoads(
      [
        { status: "QUEUED", priority: "NORMAL", queuedAt: ago(2), kitchenSection: SOUTH },
        { status: "PREPARING", priority: "HIGH", queuedAt: ago(LATE_AFTER_MINUTES + 1), kitchenSection: SOUTH },
        // READY is waiting on a server, not a cook — it does not load the station.
        { status: "READY", priority: "NORMAL", queuedAt: ago(40), kitchenSection: SOUTH },
      ],
      [SOUTH, BEV],
      NOW,
    );
    expect(loads).toEqual([
      { key: "s1", name: "South Indian", active: 2, late: 1, priority: 1, oldestMinutes: LATE_AFTER_MINUTES + 1 },
      { key: "s2", name: "Beverages", active: 0, late: 0, priority: 0, oldestMinutes: null },
    ]);
  });

  it("adds an Unassigned row only when a ticket really has no section", () => {
    expect(sectionLoads([], [SOUTH], NOW).map((l) => l.name)).toEqual(["South Indian"]);
    const loads = sectionLoads([{ status: "QUEUED", priority: "NORMAL", queuedAt: ago(1), kitchenSection: null }], [SOUTH], NOW);
    expect(loads.map((l) => [l.name, l.active])).toEqual([["South Indian", 0], ["Unassigned", 1]]);
  });

  it("a ticket is late from exactly the threshold, and only while the kitchen still owes it", () => {
    expect(isLate({ status: "QUEUED", queuedAt: ago(LATE_AFTER_MINUTES - 1) }, NOW)).toBe(false);
    expect(isLate({ status: "QUEUED", queuedAt: ago(LATE_AFTER_MINUTES) }, NOW)).toBe(true);
    expect(isLate({ status: "READY", queuedAt: ago(LATE_AFTER_MINUTES * 4) }, NOW)).toBe(false);
  });

  it("never reports negative waiting time for a clock slightly ahead of the server", () => {
    expect(minutesSince(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe(0);
  });
});
