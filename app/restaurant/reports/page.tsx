import { DataShortcuts } from "@/components/settings/data-shortcuts";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { reportRangeOrDefault, salesSummary } from "@/lib/data/reports";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/ui/format";
import { FileBarChart, TrendingUp, Award } from "lucide-react";
import { MetricCard } from "@/components/ui/metric-card";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

// Reports (S1-P04-T007 interim; LD-RPT-01…05 in S1-P19). `report:read`; aggregates are scoped to the session's tenant
// and filtered by restaurant business dates (`?from=&to=`, default the last 7 days). Only from/to are read from the URL.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireTenantPage("report:read");
  const params = await searchParams;
  const range = reportRangeOrDefault(ctx, { from: single(params.from), to: single(params.to) });
  const summary = await salesSummary(ctx, range);
  const money = (amount: string) => formatMoney(amount, ctx.restaurant.currencyCode);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="font-display text-2xl font-bold text-fg-primary">
          Daily Operational Reports
        </h1>
        <p className="text-xs text-fg-secondary mt-1">
          Performance metrics, order volume analytics, and item sales distribution.
        </p>
        <p className="text-xs text-fg-secondary mt-1 tabular-nums">
          Business dates {range.from} to {range.to} ({ctx.restaurant.timezone})
        </p>
        {hasPermission(ctx, "data:export") && (
          <div className="mt-3">
            <DataShortcuts datasets={["reports", "orders", "transactions"]} label="Report data" from={range.from} to={range.to} deleteCategory={hasPermission(ctx, "data:purge") ? "orders" : undefined} />
          </div>
        )}
      </div>

      {/* Analytics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard
          label="Gross sales"
          value={money(summary.grossSales)}
          support={`Net ${money(summary.netSales)} after ${money(summary.refunds)} refunds`}
          icon={TrendingUp}
          hue="accent"
        />
        <MetricCard label="Fulfilled orders" value={`${summary.completedCount} / ${summary.orderCount}`} support="Completed of all orders placed" icon={Award} hue="success" />
        <MetricCard label="Average order value" value={money(summary.averageOrderValue)} support="Per completed order" icon={FileBarChart} hue="warning" />
      </div>

      {/* Report Breakdown */}
      <Card className="border border-border-subtle bg-card shadow-e1 p-6 space-y-4">
        <h3 className="font-display font-bold text-lg text-fg-primary">
          Operational Summary
        </h3>
        <p className="text-xs text-fg-secondary">
          All order transactions snapshot historical product prices and tax rates at order creation time to guarantee financial immutability.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border-subtle">
          <div className="p-4 rounded-xl bg-canvas/60 border border-border-subtle space-y-2">
            <span className="text-xs tabular-nums text-fg-accent uppercase">
              Sales by Order Type
            </span>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-fg-secondary">
                <span>DINE IN</span>
                <span>{summary.byOrderType.DINE_IN.count} orders</span>
              </div>
              <div className="flex justify-between text-fg-secondary">
                <span>TAKEAWAY</span>
                <span>{summary.byOrderType.TAKEAWAY.count} orders</span>
              </div>
              <div className="flex justify-between text-fg-secondary">
                <span>DELIVERY</span>
                <span>{summary.byOrderType.DELIVERY.count} orders</span>
              </div>
            </div>
          </div>

        </div>
      </Card>
    </div>
  );
}
