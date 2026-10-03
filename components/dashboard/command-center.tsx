import Link from "next/link";
import { ChefHat, Clock, Cpu, Plus, Printer, UsersRound, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { IconTile } from "@/components/ui/icon-tile";
import { EmptyState } from "@/components/states/empty-state";
import { formatDuration } from "@/lib/ui/attendance";
import { formatInZone } from "@/lib/ui/format";
import { formatWaiting, type SectionLoad } from "@/lib/ui/kitchen-load";
import { roleLabel } from "@/lib/ui/navigation";
import { cn } from "@/lib/ui/cn";

/**
 * The dashboard's command-center panels (RASOIOS-ADR-020, after the Stitch "Operations Command Center").
 *
 * Server components over data the dashboard has already read under the caller's own tenant and permissions. Each
 * panel shows what the platform actually records; where the Stitch mock-up shows something the platform does not
 * record — delivery-aggregator channels, table occupancy, a chef per station — the panel is simply not there, rather
 * than filled with a plausible number.
 */

/** A bordered white panel with a title row — the Stitch "level 1" operational surface. */
export function Panel({
  title,
  icon,
  action,
  children,
  className,
  labelledBy,
}: {
  title: string;
  icon: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelledBy: string;
}) {
  return (
    <section aria-labelledby={labelledBy} className={cn("rise-in flex min-w-0 flex-col gap-4 rounded-2xl border border-border-subtle bg-card p-5 shadow-e1", className)}>
      <div className="flex items-center gap-3">
        <IconTile icon={icon} size="sm" tone="primary" />
        <h2 id={labelledBy} className="min-w-0 flex-1 font-display text-heading text-fg-primary">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A status pill for the context strip. The dot pulses only for something genuinely live and healthy right now — an
 * agent calling in, a kitchen with tickets on it — never as decoration (Stitch §14).
 */
export function LivePill({ tone, live = false, children }: { tone: "success" | "warning" | "danger" | "neutral"; live?: boolean; children: React.ReactNode }) {
  const dot = { success: "bg-status-success", warning: "bg-status-warning", danger: "bg-status-danger", neutral: "bg-fg-secondary" }[tone];
  return (
    <span className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border border-border-subtle bg-card px-3 text-caption font-semibold text-fg-primary">
      <span className="relative inline-flex h-2 w-2">
        {live && <span aria-hidden className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", dot)} />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", dot)} />
      </span>
      {children}
    </span>
  );
}

/** One card per kitchen section with its live load. The bar is relative to the busiest section, not a made-up capacity. */
export function StationRadar({ loads }: { loads: readonly SectionLoad[] }) {
  if (loads.length === 0) {
    return <EmptyState icon={ChefHat} title="No kitchen sections yet" description="Add kitchen sections in Settings to see each station's live load here." />;
  }
  const busiest = Math.max(1, ...loads.map((l) => l.active));
  return (
    <ul className="grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
      {loads.map((load) => {
        const tone = load.late > 0 ? "danger" : load.active > 0 ? "primary" : "neutral";
        const bar = load.late > 0 ? "bg-status-danger" : load.active > 0 ? "bg-action-primary" : "bg-border-strong";
        return (
          <li
            key={load.key}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-subtle bg-raised p-4 transition-[transform,border-color] duration-base ease-standard hover:border-border-strong motion-safe:hover:-translate-y-0.5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-label text-fg-primary">{load.name}</span>
              <Badge tone={tone}>{load.late > 0 ? `${load.late} late` : load.active > 0 ? "Busy" : "Clear"}</Badge>
            </div>
            <div className="flex items-center justify-between text-caption text-fg-secondary">
              <span>Active tickets</span>
              <span className="text-numeric font-semibold text-fg-primary">{load.active}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border-subtle" role="presentation">
              <div className={cn("bar-fill h-full rounded-full", bar)} style={{ width: `${Math.round((load.active / busiest) * 100)}%` }} />
            </div>
            <div className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <Icon icon={Clock} size={16} />
              {load.oldestMinutes === null ? "Nothing waiting" : `Oldest waiting ${formatWaiting(load.oldestMinutes)}`}
              {load.priority > 0 && <span className="ml-auto font-semibold text-status-warning">{load.priority} priority</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export type HardwareRow = { id: string; name: string; detail: string; state: "online" | "offline" | "attention" | "unknown"; stateLabel: string };

/** Printers and print agents as the agents last reported them (ADR-007 §7) — health, not a guess. */
export function HardwarePanel({ rows }: { rows: readonly HardwareRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Printer}
        title="No printer connected"
        description="Pair a print agent on the restaurant PC and add your kitchen and receipt printers."
        action={{ href: "/restaurant/printing", label: "Set up printing" }}
      />
    );
  }
  const tone = { online: "success", offline: "danger", attention: "warning", unknown: "neutral" } as const;
  return (
    <ul className="flex list-none flex-col gap-2 p-0">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-3 rounded-xl border border-border-subtle bg-raised px-3 py-2.5">
          <Icon icon={row.detail.startsWith("Agent") ? Cpu : Printer} size={18} className="text-fg-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label text-fg-primary">{row.name}</span>
            <span className="truncate text-caption text-fg-secondary">{row.detail}</span>
          </span>
          <Badge tone={tone[row.state]}>{row.stateLabel}</Badge>
        </li>
      ))}
    </ul>
  );
}

export type ShiftRow = { membershipId: string; name: string; role: string; since: string };

/** Who is signed in on a daily-password shift right now, and for how long (ADR-019). */
export function OnShiftPanel({ rows, timezone, now }: { rows: readonly ShiftRow[]; timezone: string; now: Date }) {
  if (rows.length === 0) {
    return <EmptyState icon={UsersRound} title="No staff on shift" description="Counter and kitchen staff appear here once they sign in with today's password." />;
  }
  return (
    <ul className="flex list-none flex-col gap-2 p-0">
      {rows.map((row) => (
        <li key={row.membershipId} className="flex items-center gap-3">
          <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-action-primary/12 text-caption font-bold text-fg-accent">
            {initials(row.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label text-fg-primary">{row.name}</span>
            <span className="text-caption text-fg-secondary">{roleLabel(row.role)}</span>
          </span>
          <span className="flex flex-col items-end text-caption">
            <span className="font-semibold text-numeric text-fg-accent">{formatDuration(now.getTime() - new Date(row.since).getTime())}</span>
            <span className="text-fg-secondary">since {formatInZone(row.since, timezone, "time")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The big "new order" button and the role's other destinations, as the Stitch quick-operations block. */
export function QuickOperations({ newOrder, links }: { newOrder: boolean; links: readonly { href: string; label: string; detail: string; icon: LucideIcon }[] }) {
  return (
    <div className="flex flex-col gap-3">
      {newOrder && (
        <Link
          href="/restaurant/orders/new"
          className="inline-flex h-14 items-center justify-center gap-2 rounded-xl bg-action-primary px-4 font-display text-heading text-action-primary-fg shadow-e1 transition-[transform,box-shadow,background-color] duration-base ease-standard hover:bg-action-primary-hover hover:shadow-e2 motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-px"
        >
          <Icon icon={Plus} size={20} />
          New order
        </Link>
      )}
      {links.length > 0 && (
        <ul className="grid list-none grid-cols-2 gap-3 p-0">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="group flex h-full min-h-20 flex-col gap-1 rounded-xl border border-border-subtle bg-raised p-3 transition-[transform,border-color] duration-base ease-standard hover:border-border-strong motion-safe:hover:-translate-y-0.5"
              >
                <Icon icon={link.icon} size={18} className="text-fg-accent transition-transform duration-base ease-standard motion-safe:group-hover:translate-x-0.5" />
                <span className="text-label text-fg-primary">{link.label}</span>
                <span className="text-caption text-fg-secondary">{link.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => [...part][0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}
