/**
 * Working-hours arithmetic for the staff attendance screens (RASOIOS-ADR-019 §4, C9).
 *
 * Pure and shared between server and client so a shift that is still open counts the same in both. Durations come
 * from the session rows themselves — a login and a logout instant — never from a date changing, which is what the
 * client specifically asked not to happen.
 */

export type ShiftLike = {
  loginAt: Date;
  /** Null while the shift is still open; the duration is then measured to `asOf`. */
  endedAt: Date | null;
};

/** Milliseconds worked in one shift. An open shift is measured to `asOf` so "on shift now" ticks up. */
export function shiftDurationMs(shift: ShiftLike, asOf: Date): number {
  const end = shift.endedAt ?? asOf;
  // Never negative: a clock adjustment between the two instants should read as zero, not as time travel.
  return Math.max(0, end.getTime() - shift.loginAt.getTime());
}

/** Total across several shifts — the day's real worked time when someone signed in and out more than once. */
export function totalDurationMs(shifts: readonly ShiftLike[], asOf: Date): number {
  return shifts.reduce((sum, shift) => sum + shiftDurationMs(shift, asOf), 0);
}

/**
 * `8h 37m`, `45m`, `0m`. Rounded down to the minute, because a shift that has run 59 seconds has not yet worked a
 * minute and claiming otherwise would make a day's total drift upward against the clock on the wall.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** What the administrator sees against a staff member's name (C11). */
export type StaffStanding = "ONLINE" | "OFFLINE" | "PASSWORD_EXPIRED" | "NO_PASSWORD";

export function standingOf(input: { hasActiveSession: boolean; credentialExpiresAt: Date | null }, asOf: Date): StaffStanding {
  if (input.hasActiveSession) return "ONLINE";
  if (!input.credentialExpiresAt) return "NO_PASSWORD";
  return input.credentialExpiresAt <= asOf ? "PASSWORD_EXPIRED" : "OFFLINE";
}

export const STANDING_LABEL: Record<StaffStanding, string> = {
  ONLINE: "On shift",
  OFFLINE: "Off shift",
  PASSWORD_EXPIRED: "Password expired",
  NO_PASSWORD: "No password today",
};
