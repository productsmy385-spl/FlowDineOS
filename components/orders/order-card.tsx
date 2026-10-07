"use client";

import Link from "next/link";
import { Flame } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { RailCard } from "@/components/visual/card-rail";
import type { OrderBoardItem } from "@/lib/services/orders";
import { cn } from "@/lib/ui/cn";
import { formatMoney } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, elapsedMinutes, formatDuration } from "./order-labels";

/**
 * One order on the orders rail (owner brief 2026-10-07 §2–12): a bookmark-tab card whose artwork — the first dish's
 * own photo, or the order type's illustration — rests in grayscale and blooms in the status colour when the card is
 * active. The number, status, payment, urgency, type/table/waiting time, totals and actions are always on the card;
 * the opened card also shows its first lines. Urgency is a flame *and* the word, never colour alone.
 */
const BLOOM: Record<string, string> = {
  NEW: "radial-gradient(circle at 50% 45%, rgb(var(--accent)), rgb(var(--primary)) 55%, transparent 80%)",
  ACCEPTED: "radial-gradient(circle at 50% 45%, rgb(var(--secondary)), rgb(var(--accent)) 55%, transparent 80%)",
  PREPARING: "radial-gradient(circle at 50% 45%, rgb(var(--text-warning)), rgb(var(--danger)) 60%, transparent 80%)",
  READY: "radial-gradient(circle at 50% 45%, rgb(var(--text-success)), rgb(var(--primary)) 55%, transparent 80%)",
};
const DEFAULT_BLOOM = "radial-gradient(circle at 50% 45%, rgb(var(--primary)), rgb(var(--secondary)) 60%, transparent 80%)";

export function OrderCard({
  order,
  now,
  locale,
  primaryAction,
  secondaryAction,
  active = false,
  fresh = false,
}: {
  order: OrderBoardItem;
  /** Rendered "now" in epoch ms, ticked by the board so every card agrees. */
  now: number;
  locale: string;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  active?: boolean;
  fresh?: boolean;
}) {
  const waiting = elapsedMinutes(order.createdAt, now);
  const TypeIcon = ORDER_TYPE_ICONS[order.orderType];
  const urgent = order.priority === "HIGH";
  const more = order.itemCount - order.lines.length;

  const art = order.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- tenant-configured image hosts, already validated on save
    <img src={order.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
  ) : (
    <span className="flex h-full w-full items-center justify-center bg-raised text-fg-secondary">
      <TypeIcon aria-hidden className="size-14" strokeWidth={1.25} />
    </span>
  );

  return (
    <RailCard art={art} bloom={BLOOM[order.status] ?? DEFAULT_BLOOM} active={active} fresh={fresh} accent={urgent ? "danger" : "neutral"}>
      <article aria-labelledby={`order-${order.id}`} data-testid="order-card" className="flex h-full flex-col gap-3">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
          <Link id={`order-${order.id}`} href={`/restaurant/orders/${order.id}`} tabIndex={-1} className="truncate text-subheading text-numeric text-fg-primary hover:text-fg-accent hover:underline">
            {order.orderNumber}
          </Link>
          <StatusBadge domain="order" status={order.status} />
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

        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          {order.paymentStatus && <StatusBadge domain="payment" status={order.paymentStatus} />}
          {urgent && (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-danger/12 px-2 py-0.5 text-caption text-status-danger">
              <Icon icon={Flame} size={16} />
              Urgent
            </span>
          )}
        </div>

        <dl className="grid grid-cols-[minmax(2.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border-subtle pt-3 text-body">
          <dt className="text-caption text-fg-secondary">Lines</dt>
          <dd className="text-numeric text-fg-primary">{order.itemCount}</dd>
          <dt className="text-caption text-fg-secondary">Total</dt>
          <dd className="truncate text-numeric text-fg-primary">{order.totalAmount === null ? "—" : formatMoney(order.totalAmount, order.currencyCode, locale)}</dd>
          <dt className="text-caption text-fg-secondary">Guest</dt>
          <dd className="truncate text-fg-primary" title={order.customerName ?? undefined}>
            {order.customerName ?? <span className="text-fg-secondary">—</span>}
          </dd>
        </dl>

        {/* Opened card: the first lines, revealed by row height (never by scaling the text). */}
        <div className={cn("grid transition-[grid-template-rows,opacity] duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none", active ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
          <ul className="min-h-0 overflow-hidden text-caption text-fg-primary" aria-hidden={!active}>
            {order.lines.map((line, index) => (
              <li key={index} className="truncate">
                <span className="text-numeric">{line.quantity} ×</span> {line.name}
              </li>
            ))}
            {more > 0 && <li className="text-fg-secondary">+{more} more</li>}
          </ul>
        </div>

        <footer className="mt-auto grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-border-subtle pt-3">
          <div className="min-w-0">{primaryAction}</div>
          <div className="min-w-0">{secondaryAction}</div>
          <Link href={`/restaurant/orders/${order.id}`} tabIndex={-1} className="text-label text-fg-accent hover:underline">
            Open
          </Link>
        </footer>
      </article>
    </RailCard>
  );
}
