import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { OrderBoard } from "@/components/orders/order-board";
import { OrdersViewSwitch, type OrdersView } from "@/components/orders/orders-view-switch";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { isSimplifiedWorkflowOn } from "@/lib/data/restaurant";
import { allowedOrderTransitions, getOrderBoard } from "@/lib/services/orders";
import { listOpenTableBills } from "@/lib/services/table-sessions";

export const dynamic = "force-dynamic";

const VIEWS: readonly OrdersView[] = ["takeaway", "all"];

/**
 * LD-ORD-01 — `/restaurant/orders` (S1-P12-T008, `order:read`). Dine-in tables have their own page and navigation
 * item (`/restaurant/dine-in`, owner brief 2026-10-14); this page is the live board in two views:
 *
 * - `?view=takeaway` (default): takeaway orders only — they never join a table bill;
 * - `?view=all`: every order, delivery and dine-in included, as before.
 *
 * `?view=dine-in` (an older link) goes to the Dine-in page. KITCHEN gets the kitchen projection from the service, so
 * this page never renders a customer name or an amount for that role.
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const ctx = await requireTenantPage("order:read");
  const requested = (await searchParams)?.view;
  if (requested === "dine-in") redirect("/restaurant/dine-in");
  const view: OrdersView = VIEWS.includes(requested as OrdersView) ? (requested as OrdersView) : "takeaway";
  const canCreate = hasPermission(ctx, "order:create");
  const canSeeMoney = hasPermission(ctx, "transaction:read");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Orders"
        description="Live board for today. New orders appear on their own."
        actions={
          canCreate ? (
            <Link
              href={view === "takeaway" ? "/restaurant/orders/new?type=TAKEAWAY" : "/restaurant/orders/new"}
              className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover"
            >
              New order
            </Link>
          ) : undefined
        }
      />
      <OrdersViewSwitch active={view} />
      <OrderBoard
        key={view}
        initial={await getOrderBoard(ctx, view === "takeaway" ? { type: "TAKEAWAY" } : {})}
        orderType={view === "takeaway" ? "TAKEAWAY" : undefined}
        transitions={allowedOrderTransitions(ctx)}
        timezone={ctx.restaurant.timezone}
        canCreate={canCreate}
        // Record Payment on the board belongs to the simplified order workflow; with it off the board is unchanged.
        canRecordPayment={hasPermission(ctx, "payment:record") && canSeeMoney && (await isSimplifiedWorkflowOn(ctx))}
        // Open table bills carry amounts; the Dine-in page shows them as cards, so only All orders lists them here.
        openTables={view === "all" && canSeeMoney ? await listOpenTableBills(ctx) : null}
      />
    </div>
  );
}
