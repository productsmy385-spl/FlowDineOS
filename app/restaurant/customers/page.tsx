import type { Metadata } from "next";
import { DataShortcuts } from "@/components/settings/data-shortcuts";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { NewCustomerButton } from "@/components/customers/customer-dialogs";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { FilterBar, type FilterDefinition } from "@/components/ui/filter-bar";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import type { CustomerListItemDto } from "@/lib/data/customers";
import { formatInZone, formatMoney } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { getCustomersAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Customers" };

const BASE_PATH = "/restaurant/customers";
const LIST_LIMIT = 200;

type SearchParams = Record<string, string | string[] | undefined>;
const single = (value: string | string[] | undefined) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * `/restaurant/customers` (S1-P13-T003; api.md LD-CUS-01). The list is this restaurant's own: the loader takes the
 * tenant from the session, and there is nothing in this URL that could point at another one.
 *
 * Money is formatted from the decimal string the loader returns, in the restaurant's own currency — the baseline
 * printed a dollar sign whatever the restaurant charged in (BA-27 family). Notes are staff-only, so they are shown
 * here but never leave the console.
 */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireTenantPage("customer:read");
  const params = await searchParams;
  const query = single(params.q);
  const includeArchived = single(params.archived) === "true";

  const result = await getCustomersAction({ query, includeArchived, limit: LIST_LIMIT });
  // The tenant context carries the restaurant's currency and zone, not its country, so money is formatted in the
  // default locale with the restaurant's currency — the same way every other console screen does it (ADR-010 §1).
  const money = (amount: string) => formatMoney(amount, ctx.restaurant.currencyCode);

  const filters: FilterDefinition[] = [
    { type: "search", name: "q", label: "Search customers", placeholder: "Name, phone or email" },
    { type: "select", name: "archived", label: "Archived", allLabel: "Active customers", options: [{ value: "true", label: "Include archived" }] },
  ];

  const columns: DataTableColumn<CustomerListItemDto>[] = [
    {
      key: "name",
      header: "Customer",
      primary: true,
      cell: (customer) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link href={`${BASE_PATH}/${customer.id}`} className="truncate text-subheading text-fg-primary hover:text-fg-accent" title={customer.fullName}>
            {customer.fullName}
          </Link>
          {customer.isArchived && <Badge tone="neutral">Archived</Badge>}
        </div>
      ),
      text: (customer) => customer.fullName,
    },
    { key: "phone", header: "Phone", text: (customer) => customer.phoneE164 ?? "—" },
    { key: "email", header: "Email", text: (customer) => customer.email ?? "—", truncate: true },
    { key: "orders", header: "Orders", numeric: true, text: (customer) => String(customer.orderCount) },
    {
      key: "lastOrder",
      header: "Last order",
      numeric: true,
      cell: (customer) =>
        customer.lastOrder ? (
          <span className="flex flex-col items-end">
            <span className="text-body text-fg-primary">{money(customer.lastOrder.totalAmount)}</span>
            <span className="text-caption text-fg-secondary">{formatInZone(customer.lastOrder.createdAt, ctx.restaurant.timezone, "date")}</span>
          </span>
        ) : (
          "—"
        ),
      text: (customer) => (customer.lastOrder ? money(customer.lastOrder.totalAmount) : "—"),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <PageHeader
        title="Customers"
        description="The people who order here, with what they last spent. Their details never leave this restaurant."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hasPermission(ctx, "data:export") && (
              <DataShortcuts
                datasets={["customers"]}
                label="Customers"
                importHref={hasPermission(ctx, "data:import") ? "/restaurant/settings/data#import-list" : undefined}
                deleteCategory={hasPermission(ctx, "data:purge") ? "customers" : undefined}
              />
            )}
            <NewCustomerButton can={hasPermission(ctx, "customer:create")} />
          </div>
        }
      />

      {result.ok ? (
        <div className="flex flex-col gap-6">
          <FilterBar filters={filters} resetParams={[]} />
          <DataTable
            caption="Customers"
            columns={columns}
            rows={result.data.customers}
            getRowKey={(customer) => customer.id}
            empty={
              query || includeArchived ? (
                <EmptyState
                  icon={DOMAIN_ICONS.customers}
                  title="No customers match this search"
                  description="Try part of a name, the last digits of a phone number, or clear the search."
                  action={{ href: BASE_PATH, label: "Clear search" }}
                />
              ) : (
                <EmptyState
                  icon={DOMAIN_ICONS.customers}
                  title="No customers yet"
                  description="Add someone at the counter, or they appear here as soon as an order is taken with their details."
                />
              )
            }
          />
          {result.data.customers.length >= LIST_LIMIT && (
            <p className="text-caption text-fg-secondary">
              Showing the {LIST_LIMIT} newest customers. Search by name, phone or email to find someone older than that.
            </p>
          )}
        </div>
      ) : (
        <ErrorState requestId={result.error.requestId} message={result.error.message} />
      )}
    </div>
  );
}
