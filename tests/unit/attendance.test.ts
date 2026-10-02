import { describe, expect, it } from "vitest";
import { formatDuration, shiftDurationMs, standingOf, totalDurationMs, STANDING_LABEL } from "@/lib/ui/attendance";

/**
 * TC-STAFF-110 — working-hours arithmetic (RASOIOS-ADR-019 §4, C9).
 *
 * The client's worked example is the spine of this file: two shifts in one day must total the two shifts, not the
 * span from the first login to the last logout, and never anything derived from the date changing.
 */
const at = (iso: string) => new Date(iso);

describe("TC-STAFF-110 shift duration", () => {
  it("measures a finished shift between its own two instants", () => {
    const ms = shiftDurationMs({ loginAt: at("2026-09-29T09:05:00Z"), endedAt: at("2026-09-29T17:42:00Z") }, at("2026-09-30T00:00:00Z"));
    expect(formatDuration(ms)).toBe("8h 37m");
  });

  it("measures an open shift up to now, so it ticks while someone is working", () => {
    const ms = shiftDurationMs({ loginAt: at("2026-09-29T09:05:00Z"), endedAt: null }, at("2026-09-29T12:17:00Z"));
    expect(formatDuration(ms)).toBe("3h 12m");
  });

  it("reads a backwards clock as zero rather than as negative time", () => {
    const ms = shiftDurationMs({ loginAt: at("2026-09-29T10:00:00Z"), endedAt: at("2026-09-29T09:00:00Z") }, at("2026-09-29T12:00:00Z"));
    expect(ms).toBe(0);
    expect(formatDuration(ms)).toBe("0m");
  });
});

describe("TC-STAFF-111 a day with more than one shift", () => {
  it("totals the shifts worked, not the span they sit in", () => {
    // The client's example: 09:12→13:00 and 14:00→18:00 is 7h 48m worked, across a span of 8h 48m.
    const shifts = [
      { loginAt: at("2026-09-29T09:12:00Z"), endedAt: at("2026-09-29T13:00:00Z") },
      { loginAt: at("2026-09-29T14:00:00Z"), endedAt: at("2026-09-29T18:00:00Z") },
    ];
    expect(formatDuration(totalDurationMs(shifts, at("2026-09-29T20:00:00Z")))).toBe("7h 48m");

    const span = shiftDurationMs({ loginAt: shifts[0].loginAt, endedAt: shifts[1].endedAt }, at("2026-09-29T20:00:00Z"));
    expect(formatDuration(span)).toBe("8h 48m");
  });

  it("counts a still-open second shift toward the day's total", () => {
    const total = totalDurationMs(
      [
        { loginAt: at("2026-09-29T09:00:00Z"), endedAt: at("2026-09-29T12:00:00Z") },
        { loginAt: at("2026-09-29T13:00:00Z"), endedAt: null },
      ],
      at("2026-09-29T15:30:00Z"),
    );
    expect(formatDuration(total)).toBe("5h 30m");
  });

  it("is zero for somebody who did not work", () => {
    expect(formatDuration(totalDurationMs([], at("2026-09-29T15:00:00Z")))).toBe("0m");
  });
});

describe("TC-STAFF-112 duration formatting", () => {
  it.each([
    [0, "0m"],
    [59_000, "0m"], // under a minute has not worked a minute
    [60_000, "1m"],
    [45 * 60_000, "45m"],
    [60 * 60_000, "1h 0m"],
    [(8 * 60 + 37) * 60_000, "8h 37m"],
    [25 * 60 * 60_000, "25h 0m"], // past a day it keeps counting hours rather than wrapping
  ])("%dms reads as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("rounds down, so a day's total never drifts above the clock on the wall", () => {
    expect(formatDuration(119_999)).toBe("1m");
  });
});

describe("TC-STAFF-113 what the administrator sees against a name", () => {
  const now = at("2026-09-29T12:00:00Z");

  it("someone signed in is on shift, whatever their password is doing", () => {
    expect(standingOf({ hasActiveSession: true, credentialExpiresAt: at("2026-09-29T18:30:00Z") }, now)).toBe("ONLINE");
    expect(standingOf({ hasActiveSession: true, credentialExpiresAt: null }, now)).toBe("ONLINE");
  });

  it("distinguishes no password today from one that has run out", () => {
    expect(standingOf({ hasActiveSession: false, credentialExpiresAt: null }, now)).toBe("NO_PASSWORD");
    expect(standingOf({ hasActiveSession: false, credentialExpiresAt: at("2026-09-28T18:30:00Z") }, now)).toBe("PASSWORD_EXPIRED");
    expect(standingOf({ hasActiveSession: false, credentialExpiresAt: at("2026-09-29T18:30:00Z") }, now)).toBe("OFFLINE");
  });

  it("every state has words for it, so the screen never shows a bare enum", () => {
    for (const state of ["ONLINE", "OFFLINE", "PASSWORD_EXPIRED", "NO_PASSWORD"] as const) {
      expect(STANDING_LABEL[state], state).toMatch(/[a-z]/);
    }
  });
});
