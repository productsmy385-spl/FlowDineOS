/**
 * Kitchen load per section, for the dashboard's station radar (RASOIOS-ADR-020, Stitch "Live Kitchen Station Radar").
 *
 * Pure: it takes the live tickets the kitchen board already reads and the restaurant's own kitchen sections, and
 * counts. Nothing here is a target, a capacity or a chef's name — the Stitch mock-up shows those, but the platform
 * does not record them, so they are not shown rather than invented.
 */

/**
 * A ticket counts as late once it has waited this long without being ready. **Product default, not yet confirmed by
 * the owner** — chosen as a reasonable dine-in turnaround and kept in one place so a per-restaurant setting can
 * replace it later.
 */
export const LATE_AFTER_MINUTES = 15;

export type LoadTicket = {
  status: string;
  priority: string;
  queuedAt: string;
  kitchenSection: { id: string; name: string } | null;
};

export type SectionLoad = {
  key: string;
  name: string;
  active: number;
  late: number;
  priority: number;
  /** Minutes the oldest active ticket in this section has been waiting, or null when there are none. */
  oldestMinutes: number | null;
};

/** QUEUED and PREPARING are waiting on the kitchen; READY is waiting on service, not on a cook. */
const WAITING_ON_KITCHEN = new Set(["QUEUED", "PREPARING"]);

export const minutesSince = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));

/** "4 min", "2h 05m", "11d 8h" — a ticket left over from days ago should read as days, not as 16354 minutes. */
export function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
}

export function isLate(ticket: Pick<LoadTicket, "status" | "queuedAt">, now: Date): boolean {
  return WAITING_ON_KITCHEN.has(ticket.status) && minutesSince(ticket.queuedAt, now) >= LATE_AFTER_MINUTES;
}

/**
 * One row per kitchen section the restaurant has, in its own order, plus "Unassigned" only when a ticket actually
 * has no section — so an idle station still shows as idle rather than disappearing.
 */
export function sectionLoads(tickets: readonly LoadTicket[], sections: readonly { id: string; name: string }[], now: Date): SectionLoad[] {
  const rows = new Map<string, SectionLoad>();
  for (const section of sections) rows.set(section.id, { key: section.id, name: section.name, active: 0, late: 0, priority: 0, oldestMinutes: null });

  for (const ticket of tickets) {
    if (!WAITING_ON_KITCHEN.has(ticket.status)) continue;
    const key = ticket.kitchenSection?.id ?? "unassigned";
    const row = rows.get(key) ?? { key, name: ticket.kitchenSection?.name ?? "Unassigned", active: 0, late: 0, priority: 0, oldestMinutes: null };
    row.active += 1;
    if (isLate(ticket, now)) row.late += 1;
    if (ticket.priority !== "NORMAL") row.priority += 1;
    const waited = minutesSince(ticket.queuedAt, now);
    row.oldestMinutes = row.oldestMinutes === null ? waited : Math.max(row.oldestMinutes, waited);
    rows.set(key, row);
  }
  return [...rows.values()];
}
