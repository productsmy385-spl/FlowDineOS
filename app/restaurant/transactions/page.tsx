import type { Metadata } from "next";
import { DataShortcuts } from "@/components/settings/data-shortcuts";
import Link from "next/link";
import { PaymentMethod, TransactionStatus, TransactionType } from "@prisma/client";
import { PageHeader } from "@/components/layout/page-header";
import { VoidRowAction } from "@/components/transactions/void-transaction";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { FilterBar, type FilterDefinition } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import type { TransactionListItem, TransactionTotals } from "@/lib/data/transactions";
import { formatBusinessDate, formatInZone, formatMoney } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { listTransactionsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Transactions" };

const BASE_PATH = "/restaurant/transactions";

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const isoDate = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined => (allowed.includes(value as T) ? (value as T) : undefined);

const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI" };
const TYPE_LABEL: Record<TransactionType, string> = { PAYMENT: "Payment", REFUND: "Refund" };

/**
 * `/restaurant/transactions` (S1-P18-T005; api.md LD-TXN-01, SA-TXN-03). Every payment and refund this restaurant has
 * recorded, with the totals for whatever is being looked at.
 *
 * The totals come from the loader, which sums them in PostgreSQL over NUMERIC — they are never added up from the rows
 * on this page, so a second page of results cannot make them disagree (ADR-010 §1). Voided rows stay visible, struck
 * through and badged, because the ledger is append-only and a correction that hid itself would be worse than the
 * mistake. An unknown value in the query string is ignored rather than answered with a 422.
 */
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireTenantPage("transaction:read");
  const params = await searchParams;

  const filters = {
    from: isoDate(single(params.from)),
    to: isoDate(single(params.to)),
    type: oneOf(single(params.type), Object.values(TransactionType)),
    method: oneOf(single(params.method), Object.values(PaymentMethod)),
    status: oneOf(single(params.status), Object.values(TransactionStatus)),
    q: single(params.q),
    cursor: single(params.cursor),
  };

  const result = await listTransactionsAction(filters);
  const money = (amount: string) => formatMoney(amount, ctx.restaurant.currencyCode);
  const canVoid = hasPermission(ctx, "transaction:void");
  const canCloseDay = hasPermission(ctx, "day_close:perform");
  const filtered = Object.entries(filters).some(([key, value]) => key !== "cursor" && value !== undefined);

  const filterBar: FilterDefinition[] = [
    { type: "search", name: "q", label: "Search", placeholder: "Order number or reference" },
    { type: "date", name: "from", label: "From" },
    { type: "date", name: "to", label: "To" },
    { type: "select", name: "method", label: "Method", allLabel: "All methods", options: Object.values(PaymentMethod).map((value) => ({ value, label: METHOD_LABEL[value] })) },
    { type: "select", name: "type", label: "Type", allLabel: "Payments and refunds", options: Object.values(TransactionType).map((value) => ({ value, label: TYPE_LABEL[value] })) },
    { type: "select", name: "status", label: "Status", allLabel: "All entries", options: [{ value: "SUCCESS", label: "Recorded" }, { value: "VOIDED", label: "Voided" }] },
  ];

  const columns: DataTableColumn<TransactionListItem>[] = [
    {
      key: "order",
      header: "Order",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <Link href={`/restaurant/orders/${row.orderId}`} className="text-subheading text-fg-primary hover:text-fg-accent">
            {row.orderNumber}
          </Link>
          {row.customerName && <p className="truncate text-caption text-fg-secondary">{row.customerName}</p>}
        </div>
      ),
      text: (row) => row.orderNumber,
    },
    { key: "type", header: "Type", text: (row) => TYPE_LABEL[row.type] },
    { key: "method", header: "Method", text: (row) => METHOD_LABEL[row.method] },
    {
      key: "amount",
      header: "Amount",
      numeric: true,
      cell: (row) => (
        <span className={row.status === "VOIDED" ? "line-through text-fg-secondary" : row.type === "REFUND" ? "text-status-warning" : "text-fg-primary"}>
          {row.type === "REFUND" ? `− ${money(row.amount)}` : money(row.amount)}
        </span>
      ),
      text: (row) => money(row.amount),
    },
    { key: "status", header: "Status", cell: (row) => <StatusBadge domain="transaction" status={row.status} /> },
    {
      key: "recorded",
      header: "Recorded",
      cell: (row) => (
        <span className="flex flex-col">
          <span className="text-body text-fg-primary">{formatInZone(row.createdAt, ctx.restaurant.timezone, "datetime")}</span>
          <span className="text-caption text-fg-secondary">
            {formatBusinessDate(row.businessDate)}
            {row.recordedBy ? ` · ${row.recordedBy}` : ""}
          </span>
        </span>
      ),
      text: (row) => formatInZone(row.createdAt, ctx.restaurant.timezone, "datetime"),
    },
    {
      key: "note",
      header: "Reference / reason",
      truncate: true,
      // A voided entry's reason is the only record of why the correction was made, so it wins over the reference.
      text: (row) => row.voidReason ?? row.reason ?? row.reference ?? "—",
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <PageHeader
        title="Transactions"
        description="Every payment and refund this restaurant has recorded. Nothing is ever rewritten; old history can be removed only after a backup."
        actions={
          <div className="flex flex-wrap items-center gap-2">
          {hasPermission(ctx, "data:export") && <DataShortcuts datasets={["transactions"]} label="Payments" deleteCategory={hasPermission(ctx, "data:purge") ? "orders" : undefined} />}
          {canCloseDay ? (
            <Link
              href={`${BASE_PATH}/day-close`}
              className="inline-flex h-10 items-center rounded-xl border border-border-strong bg-raised px-4 text-label text-fg-primary transition-colors duration-fast ease-standard hover:bg-border-subtle"
            >
              Close the day
            </Link>
          ) : null}
          </div>
        }
      />

      {result.ok ? (
        <div className="flex flex-col gap-6">
          <TotalsStrip totals={result.data.totals} money={money} filtered={filtered} />
          <FilterBar filters={filterBar} />
          <DataTable
            caption="Transactions"
            columns={columns}
            rows={result.data.items}
            getRowKey={(row) => row.id}
            density="compact"
            rowActions={(row) => (
              <VoidRowAction
                row={{ id: row.id, kind: TYPE_LABEL[row.type], amount: money(row.amount), orderNumber: row.orderNumber }}
                can={canVoid && row.status === "SUCCESS"}
              />
            )}
            empty={
              filtered ? (
                <EmptyState
                  icon={DOMAIN_ICONS.transactions}
                  title="No transactions match these filters"
                  description="Try a wider date range or a different method, or clear the filters."
                  action={{ href: BASE_PATH, label: "Clear filters" }}
                />
              ) : (
                <EmptyState icon={DOMAIN_ICONS.transactions} title="Nothing recorded yet" description="Payments and refunds appear here as soon as the first one is taken." />
              )
            }
          />
          <Pagination
            basePath={BASE_PATH}
            searchParams={params}
            nextCursor={result.data.nextCursor}
            summary={`Showing ${result.data.items.length} ${result.data.items.length === 1 ? "entry" : "entries"}`}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <ErrorState requestId={result.error.requestId} message={result.error.message} />
          {filters.cursor && (
            <Link href={BASE_PATH} className="text-label text-fg-accent hover:underline">
              Start from the first page
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Totals for the current filters, summed by the database over NUMERIC — never by adding up the rows on screen. */
function TotalsStrip({ totals, money, filtered }: { totals: TransactionTotals; money: (amount: string) => string; filtered: boolean }) {
  const methods = Object.values(PaymentMethod).filter((method) => totals.byMethod[method] !== "0.00");
  return (
    <Card surface="glass" padding="feature" className="gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-heading text-fg-primary">{filtered ? "These transactions" : "All transactions"}</h2>
        <p className="text-caption text-fg-secondary">
          {totals.count} {totals.count === 1 ? "entry" : "entries"}
        </p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Total term="Taken" value={money(totals.payments)} />
        <Total term="Refunded" value={money(totals.refunds)} />
        <Total term="Net" value={money(totals.net)} emphasis />
      </dl>
      {methods.length > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border-subtle pt-4">
          {methods.map((method) => (
            <div key={method} className="flex items-baseline gap-2">
              <dt className="text-caption text-fg-secondary">{METHOD_LABEL[method]}</dt>
              <dd className="text-body tabular-nums text-fg-primary">{money(totals.byMethod[method])}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function Total({ term, value, emphasis = false }: { term: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-fg-secondary">{term}</dt>
      <dd className={emphasis ? "text-display-m tabular-nums text-fg-primary" : "text-heading tabular-nums text-fg-primary"}>{value}</dd>
    </div>
  );
}
