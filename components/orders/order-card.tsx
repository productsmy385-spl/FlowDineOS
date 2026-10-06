"use client";

import Link from "next/link";
import { Flame } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import type { OrderBoardItem } from "@/lib/services/orders";
import { cn } from "@/lib/ui/cn";
import { formatMoney } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, elapsedMinutes, formatDuration } from "./order-labels";

/**
 * One live order on the board (frontend.md §5.3; owner review 2026-10-06: one stable card, not per-card patches).
 *
 * Every card has the same five rows on a CSS grid, so cards in a row line up whatever they contain:
 *   header   — order number | status, payment and urgency badges, stacked in a fixed column
 *   meta     — order type · table · waiting time, on one line that truncates rather than wraps
 *   summary  — Lines | Total | Customer, three fixed columns; an absent value shows "—" so nothing shifts
 *   actions  — primary action | cancel | Open, in fixed cells pinned to the bottom of the card
 * Urgency is a flame icon *with* the word "Urgent", never colour alone (design.md §7).
 */
export function OrderCard({
  order,
  now,
  locale,
  primaryAction,
  secondaryAction,
}: {
  order: OrderBoardItem;
  /** Rendered "now" in epoch ms, ticked by the board so every card agrees. */
  now: number;
  locale: string;
  /** The single next step the role may take (Accept, Start, Ready, Complete…). */
  primaryAction?: React.ReactNode;
  /** A quieter action, such as Cancel. */
  secondaryAction?: React.ReactNode;
}) {
  const waiting = elapsedMinutes(order.createdAt, now);
  const TypeIcon = ORDER_TYPE_ICONS[order.orderType];
  const urgent = order.priority === "HIGH";

  return (
    <article
      aria-labelledby={`order-${order.id}`}
      data-testid="order-card"
      className={cn(
        "grid min-h-[13.5rem] w-full min-w-0 grid-rows-[auto_auto_1fr_auto] gap-3 rounded-2xl border bg-card p-4 md:p-5",
        urgent ? "border-status-danger/50" : "border-border-subtle",
      )}
    >
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <Link id={`order-${order.id}`} href={`/restaurant/orders/${order.id}`} className="truncate text-heading text-numeric text-fg-primary hover:text-fg-accent hover:underline">
          {order.orderNumber}
        </Link>
        <div className="flex flex-col items-end gap-1.5">
          <StatusBadge domain="order" status={order.status} />
          {order.paymentStatus && <StatusBadge domain="payment" status={order.paymentStatus} />}
          {urgent && (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-danger/12 px-2 py-0.5 text-caption text-status-danger">
              <Icon icon={Flame} size={16} />
              Urgent
            </span>
          )}
        </div>
      </header>

      <p className="flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap text-caption text-fg-secondary">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Icon icon={TypeIcon} size={16} />
          {ORDER_TYPE_LABELS[order.orderType]}
        </span>
        {order.tableLabel && <span className="truncate">Table {order.tableLabel}</span>}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          <Icon icon={DOMAIN_ICONS.timer} size={16} />
          <time dateTime={order.createdAt}>{formatDuration(waiting)}</time>
        </span>
      </p>

      <dl className="grid grid-cols-[minmax(3.5rem,auto)_minmax(5.5rem,1fr)_minmax(0,1.4fr)] content-start gap-x-4 gap-y-1 border-t border-border-subtle pt-3">
        <div className="min-w-0">
          <dt className="text-caption text-fg-secondary">Lines</dt>
          <dd className="text-subheading text-numeric text-fg-primary">{order.itemCount}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-fg-secondary">Total</dt>
          <dd className="truncate text-subheading text-numeric text-fg-primary">{order.totalAmount === null ? "—" : formatMoney(order.totalAmount, order.currencyCode, locale)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-fg-secondary">Customer</dt>
          <dd className="truncate text-body text-fg-primary" title={order.customerName ?? undefined}>
            {order.customerName ?? <span className="text-fg-secondary">—</span>}
          </dd>
        </div>
      </dl>

      <footer className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-border-subtle pt-3">
        <div className="min-w-0">{primaryAction}</div>
        <div className="min-w-0">{secondaryAction}</div>
        <Link href={`/restaurant/orders/${order.id}`} className="text-label text-fg-accent hover:underline">
          Open
        </Link>
      </footer>
    </article>
  );
}
