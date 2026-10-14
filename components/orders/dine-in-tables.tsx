"use client";

import * as React from "react";
import Link from "next/link";
import { Clock, Plus, ReceiptText, Utensils } from "lucide-react";
import { listDineInTablesAction } from "@/app/restaurant/orders/table-actions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/states/empty-state";
import type { DineInTable, TableBillState } from "@/lib/services/table-sessions";
import { formatMoney, localeForCountry } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { useConsoleSession } from "@/lib/ui/session-context";
import { BILL_STATE_LABEL } from "./table-bill-panel";

/**
 * Dine-in table overview (RASOIOS-ADR-027): one card per table. A table is occupied exactly while it has an OPEN bill
 * (the table-session rule, never the latest order's status); everything on a card is the server's answer, refreshed
 * every 10 s. Amounts appear only for roles that may see money.
 */
type Filter = "ALL" | "AVAILABLE" | "OCCUPIED" | "READY";

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "ALL", label: "All tables" },
  { id: "AVAILABLE", label: "Available" },
  { id: "OCCUPIED", label: "Occupied" },
  { id: "READY", label: "Ready" },
];

/** Food is out for every billed order: ready, or ready and waiting for payment. */
const READY_STATES = new Set<TableBillState>(["READY", "PAYMENT_PENDING"]);

const matches = (table: DineInTable, filter: Filter) =>
  filter === "ALL" ? true : filter === "AVAILABLE" ? table.bill === null : filter === "OCCUPIED" ? table.bill !== null : table.bill !== null && READY_STATES.has(table.bill.state);

/** Card accent per state: a left border and a dot, with the state also written out (never colour alone). */
const STATE_STYLE: Record<TableBillState | "AVAILABLE", { label: string; bar: string; dot: string }> = {
  AVAILABLE: { label: "Available", bar: "border-l-status-success", dot: "bg-status-success" },
  OPEN: { label: "Occupied", bar: "border-l-status-warning", dot: "bg-status-warning" },
  PREPARING: { label: BILL_STATE_LABEL.PREPARING, bar: "border-l-status-info", dot: "bg-status-info" },
  READY: { label: BILL_STATE_LABEL.READY, bar: "border-l-status-success", dot: "bg-status-success" },
  PARTIALLY_PAID: { label: BILL_STATE_LABEL.PARTIALLY_PAID, bar: "border-l-action-primary", dot: "bg-action-primary" },
  PAYMENT_PENDING: { label: BILL_STATE_LABEL.PAYMENT_PENDING, bar: "border-l-status-danger", dot: "bg-status-danger" },
  // Never shown for a card (only OPEN bills are listed), kept so every state has a style.
  SETTLED: { label: BILL_STATE_LABEL.SETTLED, bar: "border-l-border-strong", dot: "bg-border-strong" },
  CLOSED: { label: BILL_STATE_LABEL.CLOSED, bar: "border-l-border-strong", dot: "bg-border-strong" },
};

const POLL_MS = 10_000;

function elapsed(fromIso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function DineInTables({
  initial,
  currencyCode,
  can,
}: {
  initial: DineInTable[];
  currencyCode: string;
  can: { createOrder: boolean; viewBill: boolean };
}) {
  const session = useConsoleSession();
  const locale = localeForCountry(session?.activeTenant.countryCode);
  const [tables, setTables] = React.useState(initial);
  const [filter, setFilter] = React.useState<Filter>("ALL");
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(async () => {
      setNow(Date.now());
      const result = await listDineInTablesAction();
      if (result.ok) setTables(result.data as DineInTable[]);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const visible = tables.filter((table) => matches(table, filter));
  const count = (id: Filter) => tables.filter((table) => matches(table, id)).length;
  const money = (amount: string) => formatMoney(amount, currencyCode, locale);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label="Filter tables" className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
              onClick={() => setFilter(entry.id)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-3 text-label transition-colors duration-fast ease-standard ${
                filter === entry.id ? "border-action-primary bg-action-primary/12 text-fg-accent" : "border-border-subtle bg-card text-fg-secondary hover:text-fg-primary"
              }`}
            >
              {entry.label}
              <span className="text-numeric text-caption">{count(entry.id)}</span>
            </button>
          ))}
        </div>
        {can.createOrder && (
          <Link
            href="/restaurant/orders/new"
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-action-primary px-4 text-label text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover"
          >
            <Plus className="size-4" aria-hidden />
            New Order
          </Link>
        )}
      </div>

      {tables.length === 0 ? (
        <Card>
          <EmptyState
            icon={DOMAIN_ICONS.dineIn}
            title="No tables yet"
            description="Add your tables in Settings → Tables, or type a table on a dine-in order — its bill appears here."
            {...(can.createOrder ? { action: { href: "/restaurant/orders/new", label: "New order" } } : {})}
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={DOMAIN_ICONS.dineIn} title={`No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} right now`} description="Choose All tables to see every table." />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4" aria-label="Tables">
          {visible.map((table) => (
            <li key={table.key} className="flex">
              <TableCard table={table} now={now} money={money} can={can} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TableCard({ table, now, money, can }: { table: DineInTable; now: number; money: (amount: string) => string; can: { createOrder: boolean; viewBill: boolean } }) {
  const style = STATE_STYLE[table.bill ? table.bill.state : "AVAILABLE"];
  const bill = table.bill;
  const billHref = bill ? `/restaurant/orders/tables/${bill.id}` : null;
  const addHref = bill ? `/restaurant/orders/new?bill=${bill.id}` : `/restaurant/orders/new?table=${encodeURIComponent(table.label)}`;

  return (
    <article className={`flex w-full flex-col gap-3 rounded-2xl border border-l-4 border-border-subtle bg-card p-4 ${style.bar}`} aria-label={`Table ${table.label}, ${style.label}`}>
      <header className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate font-display text-subheading text-fg-primary">Table {table.label}</h3>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-fg-primary">
          <span className={`size-2 rounded-full ${style.dot}`} aria-hidden />
          {style.label}
        </span>
      </header>

      {bill ? (
        <dl className="flex flex-col gap-1 text-body">
          <div className="flex justify-between gap-3">
            <dt className="text-fg-secondary">Orders</dt>
            <dd className="text-numeric text-fg-primary">{bill.orderCount}</dd>
          </div>
          {bill.balance !== null && (
            <div className="flex justify-between gap-3">
              <dt className="text-fg-secondary">Due</dt>
              <dd className="text-numeric font-semibold text-fg-primary">{money(bill.balance)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 text-caption">
            <dt className="inline-flex items-center gap-1 text-fg-secondary">
              <Clock className="size-3.5" aria-hidden />
              Seated
            </dt>
            <dd className="text-numeric text-fg-secondary">{elapsed(bill.openedAt, now)}</dd>
          </div>
          <div className="text-caption text-fg-secondary text-numeric">{bill.billNumber}</div>
        </dl>
      ) : (
        <p className="text-body text-fg-secondary">No active bill</p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {bill && can.viewBill && billHref && (
          <Link href={billHref} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-action-primary px-3 text-label text-action-primary-fg hover:bg-action-primary-hover">
            <ReceiptText className="size-4" aria-hidden />
            View Bill
          </Link>
        )}
        {can.createOrder && (
          <Link
            href={addHref}
            className={`inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-label ${
              bill && can.viewBill ? "border border-border-strong text-fg-primary hover:bg-raised" : "bg-action-primary text-action-primary-fg hover:bg-action-primary-hover"
            }`}
          >
            {bill ? <Plus className="size-4" aria-hidden /> : <Utensils className="size-4" aria-hidden />}
            {bill ? "Add Items" : "Start Order"}
          </Link>
        )}
      </div>
    </article>
  );
}
