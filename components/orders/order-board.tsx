"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OrderStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { SearchField } from "@/components/ui/inputs";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/states/empty-state";
import { StaleBanner } from "@/components/states/stale-banner";
import type { OrderBoardItem, OrderBoardPage } from "@/lib/services/orders";
import { formatInZone, formatMoney, localeForCountry } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { useConsoleSession } from "@/lib/ui/session-context";
import { usePolling } from "@/lib/ui/use-polling";
import { updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { CancelOrderDialog } from "./cancel-order-dialog";
import { CardRail } from "@/components/visual/card-rail";
import { OrderCard } from "./order-card";
import { ORDER_TYPE_LABELS, TRANSITION_LABELS, type TransitionTarget } from "./order-labels";

/**
 * Live order board (S1-P12-T008; frontend.md §5.3, api.md LD-ORD-01 / RH-ORD-01 / SA-ORD-02).
 *
 * The first page is rendered on the server; from then on the board polls `GET /api/v1/orders?since=` every 10 seconds
 * (ADR-009) and merges the delta by id, so a card moves, updates or disappears without a full reload. A missed poll
 * raises the stale banner, and a new order is announced politely for screen readers.
 *
 * `transitions` is the server's own answer to "what may this role move an order to", so the card shows only real
 * buttons — and the server re-checks every request anyway (SC-RBAC-08).
 */
const POLL_INTERVAL_MS = 10_000;

const ACTIVE: readonly OrderStatus[] = ["NEW", "ACCEPTED", "PREPARING", "READY"];

type Tab = { id: string; label: string; status?: OrderStatus };

const TABS: readonly Tab[] = [
  { id: "ALL", label: "Active" },
  { id: "NEW", label: "New", status: "NEW" },
  { id: "ACCEPTED", label: "Accepted", status: "ACCEPTED" },
  { id: "PREPARING", label: "Preparing", status: "PREPARING" },
  { id: "READY", label: "Ready", status: "READY" },
  { id: "COMPLETED", label: "Completed today", status: "COMPLETED" },
  { id: "CANCELLED", label: "Cancelled today", status: "CANCELLED" },
];

function mergeDelta(current: readonly OrderBoardItem[], delta: readonly OrderBoardItem[]): OrderBoardItem[] {
  if (delta.length === 0) return [...current];
  const byId = new Map(current.map((order) => [order.id, order]));
  for (const order of delta) byId.set(order.id, order);
  return [...byId.values()];
}

function sortForBoard(orders: readonly OrderBoardItem[]): OrderBoardItem[] {
  const active = orders
    .filter((order) => ACTIVE.includes(order.status))
    .sort((a, b) => (a.priority === b.priority ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : a.priority === "HIGH" ? -1 : 1));
  const closed = orders.filter((order) => !ACTIVE.includes(order.status)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return [...active, ...closed];
}

export function OrderBoard({
  initial,
  transitions,
  timezone,
  canCreate,
}: {
  initial: OrderBoardPage;
  transitions: Record<OrderStatus, TransitionTarget[]>;
  timezone: string;
  canCreate: boolean;
}) {
  const session = useConsoleSession();
  const locale = localeForCountry(session?.activeTenant.countryCode);
  const router = useRouter();
  const toast = useToast();
  const [orders, setOrders] = React.useState<OrderBoardItem[]>(() => sortForBoard(initial.items));
  const [tab, setTab] = React.useState<string>("ALL");
  const [query, setQuery] = React.useState("");
  const [now, setNow] = React.useState(() => Date.now());
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<OrderBoardItem | null>(null);
  const [cancelError, setCancelError] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const knownIds = React.useRef(new Set(initial.items.map((order) => order.id)));

  // One clock for every card, so the waiting times on the board always agree.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const onDelta = React.useCallback((page: OrderBoardPage) => {
    const arrivals = page.items.filter((order) => !knownIds.current.has(order.id));
    for (const order of page.items) knownIds.current.add(order.id);
    if (arrivals.length > 0) {
      const first = arrivals[0];
      setAnnouncement(
        arrivals.length === 1
          ? `New order ${first.orderNumber}${first.tableLabel ? `, table ${first.tableLabel}` : ""}`
          : `${arrivals.length} new orders`,
      );
    }
    setOrders((current) => sortForBoard(mergeDelta(current, page.items)));
  }, []);

  const { stale, lastSuccessAt, refetch } = usePolling<OrderBoardPage>({
    url: "/api/v1/orders",
    intervalMs: POLL_INTERVAL_MS,
    onData: onDelta,
    select: (body) => {
      const page = body as OrderBoardPage;
      return { data: page, cursor: page.serverTime };
    },
  });

  const needle = query.trim().toLowerCase();
  const visible = orders.filter((order) => {
    const wanted = TABS.find((entry) => entry.id === tab);
    if (wanted?.status ? order.status !== wanted.status : !ACTIVE.includes(order.status)) return false;
    if (!needle) return true;
    return [order.orderNumber, order.tableLabel, order.customerName, ORDER_TYPE_LABELS[order.orderType]]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle));
  });

  const countFor = (entry: Tab) => orders.filter((order) => (entry.status ? order.status === entry.status : ACTIVE.includes(order.status))).length;

  async function move(order: OrderBoardItem, target: TransitionTarget, reason?: string) {
    setPendingId(order.id);
    setCancelError(null);
    const result = await updateOrderStatusAction({ orderId: order.id, status: target, reason });
    setPendingId(null);
    if (!result.ok) {
      const message = result.error.fieldErrors?.reason?.[0] ?? result.error.message;
      if (target === "CANCELLED") setCancelError(message);
      else toast.error(message);
      // A conflict means someone else moved it: take the server's word for it.
      void refetch();
      return;
    }
    setCancelling(null);
    toast.success(`Order ${order.orderNumber} is now ${result.data.status.toLowerCase()}.`);
    void refetch();
    router.refresh();
  }

  const closedColumns: DataTableColumn<OrderBoardItem>[] = [
    {
      key: "orderNumber",
      header: "Order",
      primary: true,
      cell: (order) => (
        <Link href={`/restaurant/orders/${order.id}`} className="text-label text-numeric text-fg-accent hover:underline">
          {order.orderNumber}
        </Link>
      ),
      text: (order) => order.orderNumber,
    },
    { key: "type", header: "Type", text: (order) => ORDER_TYPE_LABELS[order.orderType] },
    { key: "table", header: "Table", text: (order) => order.tableLabel ?? "—" },
    { key: "customer", header: "Customer", truncate: true, text: (order) => order.customerName ?? "—" },
    { key: "items", header: "Lines", numeric: true, text: (order) => String(order.itemCount) },
    {
      key: "total",
      header: "Total",
      numeric: true,
      cell: (order) => (order.totalAmount === null ? "—" : formatMoney(order.totalAmount, order.currencyCode, locale)),
      text: (order) => order.totalAmount ?? "",
    },
    { key: "status", header: "Status", cell: (order) => <StatusBadge domain="order" status={order.status} /> },
    {
      key: "time",
      header: "Placed",
      cell: (order) => (
        <time dateTime={order.createdAt} title={order.createdAt}>
          {formatInZone(order.createdAt, timezone, "time", locale)}
        </time>
      ),
      text: (order) => order.createdAt,
    },
  ];

  const showingClosed = tab === "COMPLETED" || tab === "CANCELLED";

  return (
    <div className="flex flex-col gap-6">
      <StaleBanner stale={stale} lastSuccessAt={lastSuccessAt} timezone={timezone} />

      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        {/* A swipeable rail on a phone (no scrollbar), wrapping rows from a tablet up — never wider than the page. */}
        <div role="tablist" aria-label="Order status" className="-mx-4 flex min-w-0 flex-nowrap gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-3 text-label transition-colors duration-fast ease-standard ${
                tab === entry.id ? "border-action-primary bg-action-primary/12 text-fg-accent" : "border-border-subtle bg-card text-fg-secondary hover:text-fg-primary"
              }`}
            >
              {entry.label}
              <span className="text-numeric text-caption">{countFor(entry)}</span>
            </button>
          ))}
        </div>
        <div className="w-full shrink-0 lg:w-72">
          <SearchField label="Search orders" placeholder="Order number, table or customer" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={DOMAIN_ICONS.orders}
            title={needle ? "No orders match your search" : showingClosed ? "Nothing closed today yet" : "No active orders"}
            description={
              needle
                ? "Clear the search to see the whole board."
                : showingClosed
                  ? "Completed and cancelled orders from today appear here."
                  : "Orders taken at the counter appear here as soon as they are saved."
            }
            {...(canCreate && !needle && !showingClosed ? { action: { href: "/restaurant/orders/new", label: "New order" } } : {})}
          />
        </Card>
      ) : showingClosed ? (
        <DataTable
          columns={closedColumns}
          rows={visible}
          getRowKey={(order) => order.id}
          caption="Orders closed today"
          empty={<EmptyState icon={DOMAIN_ICONS.orders} title="Nothing closed today yet" description="Completed and cancelled orders from today appear here." />}
        />
      ) : (
        // Every active order the filter keeps, on one rail — 1 card or 100, nothing sliced (owner brief 2026-10-07 §3).
        <CardRail
          items={visible}
          keyOf={(order) => order.id}
          label="Orders"
          onOpen={(order) => router.push(`/restaurant/orders/${order.id}`)}
          renderCard={(order, state) => {
            const targets = transitions[order.status] ?? [];
            const forward = targets.filter((target) => target !== "CANCELLED");
            return (
              <OrderCard
                order={order}
                now={now}
                locale={locale}
                active={state.active}
                fresh={state.fresh}
                primaryAction={
                  forward.length > 0 ? (
                    <span className="flex flex-wrap gap-2">
                      {forward.map((target) => (
                        <Button key={target} size="sm" variant="primary" loading={pendingId === order.id} loadingLabel="Saving…" onClick={() => void move(order, target)}>
                          {TRANSITION_LABELS[target]}
                        </Button>
                      ))}
                    </span>
                  ) : null
                }
                secondaryAction={
                  targets.includes("CANCELLED") ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pendingId === order.id}
                      onClick={() => {
                        setCancelError(null);
                        setCancelling(order);
                      }}
                    >
                      {TRANSITION_LABELS.CANCELLED}
                    </Button>
                  ) : null
                }
              />
            );
          }}
        />
      )}

      <CancelOrderDialog
        open={cancelling !== null}
        orderNumber={cancelling?.orderNumber ?? ""}
        pending={pendingId !== null}
        error={cancelError}
        onClose={() => {
          setCancelling(null);
          setCancelError(null);
        }}
        onConfirm={(reason) => {
          if (cancelling) void move(cancelling, "CANCELLED", reason);
        }}
      />
    </div>
  );
}
