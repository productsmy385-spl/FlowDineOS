"use client";

import Link from "next/link";
import { ChefHat, Flame, Printer } from "lucide-react";
import type { KotStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { RailCard } from "@/components/visual/card-rail";
import type { BoardTicket } from "@/lib/data/kitchen";
import { cn } from "@/lib/ui/cn";
import { DOMAIN_ICONS, STATUS_ICONS } from "@/lib/ui/icons";
import { ORDER_TYPE_LABELS, elapsedMinutes, formatDuration } from "@/components/orders/order-labels";

/**
 * One kitchen ticket on a status rail (owner brief 2026-10-07 §15–21): the same bookmark-tab card as the orders rail,
 * with kitchen content.
 *
 * Closed: KOT number, order number, table or type, timer, urgency, the first items and the one next action — what a
 * cook needs at arm's length. Active (hover, keyboard focus or tap on its rail): the full ticket — every item, add-ons,
 * instructions, notes, round, target time, print state — plus Open order and Reprint KOT where the role may use them.
 * It opens by row height, never by scaling. No customer name or money reaches this card: the kitchen projection never
 * sends them (security.md, kitchen projection), so the brief's "customer" line is deliberately absent.
 */
export const KITCHEN_NEXT: Partial<Record<KotStatus, { to: KotStatus; label: string }>> = {
  QUEUED: { to: "PREPARING", label: "Start" },
  PREPARING: { to: "READY", label: "Mark ready" },
  READY: { to: "SERVED", label: "Served" },
};

/** design.md §11: warning at the target prep time, overdue at +50 %. */
export function lateness(minutes: number, target: number | null): "ontime" | "warning" | "overdue" {
  if (target === null || target <= 0) return "ontime";
  if (minutes >= Math.ceil(target * 1.5)) return "overdue";
  return minutes >= target ? "warning" : "ontime";
}

const BLOOM: Record<string, string> = {
  QUEUED: "radial-gradient(circle at 50% 45%, rgb(var(--accent)), rgb(var(--secondary)) 55%, transparent 80%)",
  PREPARING: "radial-gradient(circle at 50% 45%, rgb(var(--text-warning)), rgb(var(--danger)) 60%, transparent 80%)",
  READY: "radial-gradient(circle at 50% 45%, rgb(var(--text-success)), rgb(var(--primary)) 55%, transparent 80%)",
};

const COMPACT_ITEMS = 2;

export function KotCard({
  ticket,
  now,
  action,
  pending,
  onAdvance,
  focused = false,
  fresh = false,
  canOpenOrder = false,
  canReprint = false,
  onReprint,
}: {
  ticket: BoardTicket;
  now: number;
  /** The move this role may make from the ticket's status, or null when it may only watch. */
  action: { to: KotStatus; label: string } | null;
  pending: boolean;
  onAdvance: (to: KotStatus) => void;
  focused?: boolean;
  fresh?: boolean;
  canOpenOrder?: boolean;
  canReprint?: boolean;
  onReprint?: () => void;
}) {
  const since = ticket.status === "PREPARING" && ticket.preparingAt ? ticket.preparingAt : ticket.queuedAt;
  const minutes = elapsedMinutes(since, now);
  const state = lateness(minutes, ticket.targetPrepMinutes);
  const timerClass = state === "overdue" ? "text-status-danger" : state === "warning" ? "text-status-warning" : "text-fg-secondary";
  const urgent = ticket.priority === "HIGH";
  const shown = focused ? ticket.items : ticket.items.slice(0, COMPACT_ITEMS);
  const hidden = ticket.items.length - shown.length;

  const art = (
    <span className="flex h-full w-full items-center justify-center bg-raised text-fg-secondary">
      <ChefHat aria-hidden className="size-14" strokeWidth={1.25} />
    </span>
  );

  return (
    <RailCard art={art} bloom={BLOOM[ticket.status] ?? BLOOM.QUEUED} active={focused} fresh={fresh} accent={urgent || state === "overdue" ? "danger" : state === "warning" ? "warning" : "neutral"}>
      <article data-testid="kot-card" data-focused={focused || undefined} className="flex h-full flex-col gap-3">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <div className="min-w-0">
            <p className="text-kitchen-number leading-none text-fg-primary">{ticket.kotNumber}</p>
            <p className="mt-1 truncate text-label text-fg-secondary">
              {ticket.orderNumber} · {ticket.tableLabel ? `Table ${ticket.tableLabel}` : ORDER_TYPE_LABELS[ticket.orderType]}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <p className={cn("inline-flex items-center gap-1 text-label text-numeric", timerClass)}>
              <Icon icon={DOMAIN_ICONS.timer} size={16} />
              {state === "overdue" ? `+${formatDuration(minutes - (ticket.targetPrepMinutes ?? 0))}` : formatDuration(minutes)}
            </p>
            {urgent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-danger/12 px-2 py-0.5 text-caption text-status-danger">
                <Icon icon={Flame} size={16} />
                Urgent
              </span>
            )}
          </div>
        </header>

        <ul className="flex flex-col gap-1">
          {shown.map((item) => (
            <li key={item.id}>
              <p className="text-subheading text-fg-primary">
                <span className="text-numeric">{item.quantity} ×</span> {item.label}
              </p>
              {focused && item.addons && <p className="text-body text-fg-secondary">{item.addons}</p>}
              {focused && item.instructions && <p className="mt-1 border-l-2 border-status-warning pl-2 text-body text-status-warning">{item.instructions}</p>}
            </li>
          ))}
          {hidden > 0 && <li className="text-label text-fg-secondary">+{hidden} more</li>}
        </ul>

        <div className={cn("grid transition-[grid-template-rows,opacity] duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none", focused ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} aria-hidden={!focused}>
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-3">
              {ticket.notes && <p className="border-l-2 border-status-warning pl-2 text-body text-status-warning">{ticket.notes}</p>}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-caption">
                <dt className="text-fg-secondary">Type</dt>
                <dd className="text-fg-primary">{ORDER_TYPE_LABELS[ticket.orderType]}</dd>
                {ticket.roundNumber > 1 && (
                  <>
                    <dt className="text-fg-secondary">Round</dt>
                    <dd className="text-fg-primary">{ticket.roundNumber}</dd>
                  </>
                )}
                {ticket.targetPrepMinutes !== null && (
                  <>
                    <dt className="text-fg-secondary">Target</dt>
                    <dd className="text-fg-primary">{formatDuration(ticket.targetPrepMinutes)}</dd>
                  </>
                )}
                {ticket.printStatus !== "NONE" && (
                  <>
                    <dt className="text-fg-secondary">Ticket print</dt>
                    <dd className="min-w-0">
                      <StatusBadge domain="printJob" status={ticket.printStatus} />
                    </dd>
                  </>
                )}
              </dl>
              {(canOpenOrder || canReprint) && (
                <div className="flex flex-wrap gap-2">
                  {canOpenOrder && (
                    <Link href={`/restaurant/orders/${ticket.orderId}`} tabIndex={focused ? 0 : -1} className="inline-flex h-10 items-center rounded-xl border border-border-strong px-3 text-label text-fg-primary hover:bg-raised">
                      Open order
                    </Link>
                  )}
                  {canReprint && (
                    <Button size="sm" variant="secondary" icon={Printer} tabIndex={focused ? 0 : -1} onClick={onReprint}>
                      Reprint KOT
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto">
          {action ? (
            <Button variant="primary" size="touch" className="w-full" loading={pending} loadingLabel="Saving…" onClick={() => onAdvance(action.to)}>
              {action.label}
            </Button>
          ) : (
            <p className="inline-flex items-center gap-2 text-label text-fg-secondary">
              <Icon icon={STATUS_ICONS.kot[ticket.status].icon} size={18} />
              {STATUS_ICONS.kot[ticket.status].label}
            </p>
          )}
        </div>
      </article>
    </RailCard>
  );
}
