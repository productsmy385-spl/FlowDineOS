"use client";

import Link from "next/link";
import { ChevronDown, Flame, Printer } from "lucide-react";
import type { KotStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import type { BoardTicket } from "@/lib/data/kitchen";
import { cn } from "@/lib/ui/cn";
import { DOMAIN_ICONS, STATUS_ICONS } from "@/lib/ui/icons";
import { ORDER_TYPE_LABELS, elapsedMinutes, formatDuration } from "@/components/orders/order-labels";

/**
 * One kitchen ticket on the rail (design.md §11; owner review 2026-10-06, "framed tickets on a rail, the focused one
 * opened out to carry its caption").
 *
 * Closed, a ticket shows what a cook needs at arm's length — KOT number, table, timer, urgency, every item with its
 * quantity, and its one next action. Focused (tap, click or keyboard focus), it opens out to carry the rest: add-ons,
 * instructions, notes, order number, round, print state, and Open order / Reprint. It opens by animating its own row
 * height (grid-template-rows 0fr → 1fr over 0.6 s, cubic-bezier(.22,1,.36,1)) — never by scaling, so text and icons stay
 * their size. Other tickets dim slightly while one is open, never to unreadable. No customer name or money reaches
 * this card: the kitchen projection never sends them.
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

const EASE = "duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:duration-0";

export function KotCard({
  ticket,
  now,
  action,
  pending,
  onAdvance,
  focused = false,
  dimmed = false,
  onFocusChange,
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
  /** Another ticket in the column is open. */
  dimmed?: boolean;
  onFocusChange?: (focused: boolean) => void;
  canOpenOrder?: boolean;
  canReprint?: boolean;
  onReprint?: () => void;
}) {
  const since = ticket.status === "PREPARING" && ticket.preparingAt ? ticket.preparingAt : ticket.queuedAt;
  const minutes = elapsedMinutes(since, now);
  const state = lateness(minutes, ticket.targetPrepMinutes);
  const timerClass = state === "overdue" ? "text-status-danger" : state === "warning" ? "text-status-warning" : "text-fg-secondary";
  const hasExtras = ticket.items.some((i) => i.addons || i.instructions) || Boolean(ticket.notes);
  const detailsId = `kot-details-${ticket.id}`;

  return (
    <article
      data-testid="kot-card"
      data-focused={focused || undefined}
      onClick={(event) => {
        // A tap anywhere on the ticket except its buttons and links opens or closes it.
        if (!(event.target as HTMLElement).closest("button, a")) onFocusChange?.(!focused);
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col rounded-2xl border bg-card p-4 transition-[opacity,filter,box-shadow,border-color]",
        EASE,
        ticket.priority === "HIGH" ? "border-status-danger/50" : "border-border-subtle",
        focused ? "border-action-primary/60 shadow-e2" : "shadow-e1",
        dimmed && !focused && "opacity-80 saturate-[.85]",
      )}
    >
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <p className="text-kitchen-number text-fg-primary">{ticket.kotNumber}</p>
          <p className="truncate text-subheading text-fg-secondary">{ticket.tableLabel ? `Table ${ticket.tableLabel}` : ORDER_TYPE_LABELS[ticket.orderType]}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <p className={cn("inline-flex items-center gap-1.5 text-subheading text-numeric", timerClass)}>
            <Icon icon={DOMAIN_ICONS.timer} size={20} />
            {state === "overdue" ? `+${formatDuration(minutes - (ticket.targetPrepMinutes ?? 0))}` : formatDuration(minutes)}
          </p>
          {ticket.priority === "HIGH" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-danger/12 px-2 py-0.5 text-label text-status-danger">
              <Icon icon={Flame} size={16} />
              Urgent
            </span>
          )}
        </div>
      </header>

      <ul className="mt-3 flex flex-col gap-1.5">
        {ticket.items.map((item) => (
          <li key={item.id} className="text-kitchen-item text-fg-primary">
            <span className="text-numeric">{item.quantity} ×</span> {item.label}
          </li>
        ))}
      </ul>

      {/* The part that opens out. Height animates through grid rows; content keeps its size. */}
      <div id={detailsId} className={cn("grid transition-[grid-template-rows,opacity]", EASE, focused ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} aria-hidden={!focused}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3 pt-3">
            {hasExtras && (
              <ul className="flex flex-col gap-2">
                {ticket.items
                  .filter((item) => item.addons || item.instructions)
                  .map((item) => (
                    <li key={item.id}>
                      <p className="text-label text-fg-primary">{item.label}</p>
                      {item.addons && <p className="text-body text-fg-secondary">{item.addons}</p>}
                      {item.instructions && <p className="mt-1 border-l-2 border-status-warning pl-2 text-body text-status-warning">{item.instructions}</p>}
                    </li>
                  ))}
                {ticket.notes && <li className="border-l-2 border-status-warning pl-2 text-body text-status-warning">{ticket.notes}</li>}
              </ul>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-caption">
              <dt className="text-fg-secondary">Order</dt>
              <dd className="text-numeric text-fg-primary">{ticket.orderNumber}</dd>
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
              <dt className="text-fg-secondary">Status</dt>
              <dd>
                <StatusBadge domain="kot" status={ticket.status} />
              </dd>
              {ticket.printStatus !== "NONE" && (
                <>
                  <dt className="text-fg-secondary">Ticket print</dt>
                  <dd>
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

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
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
        <button
          type="button"
          aria-expanded={focused}
          aria-controls={detailsId}
          aria-label={focused ? `Close ticket ${ticket.kotNumber}` : `Open ticket ${ticket.kotNumber}`}
          onClick={() => onFocusChange?.(!focused)}
          className="flex size-12 items-center justify-center rounded-xl border border-border-strong text-fg-primary hover:bg-raised"
        >
          <ChevronDown aria-hidden className={cn("size-5 transition-transform", EASE, focused && "rotate-180")} />
        </button>
      </div>
    </article>
  );
}
