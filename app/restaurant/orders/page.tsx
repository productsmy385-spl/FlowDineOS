import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { OrderBoard } from "@/components/orders/order-board";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { isSimplifiedWorkflowOn } from "@/lib/data/restaurant";
import { allowedOrderTransitions, getOrderBoard } from "@/lib/services/orders";
import { listOpenTableBills } from "@/lib/services/table-sessions";

export const dynamic = "force-dynamic";

/**
 * LD-ORD-01 — `/restaurant/orders` (S1-P12-T008, `order:read`). The first page of the board is rendered on the
 * server; the client component then polls RH-ORD-01 every 10 s (ADR-009). KITCHEN gets the kitchen projection from
 * the service, so this page never renders a customer name or an amount for that role.
 */
export default async function OrdersPage() {
  const ctx = await requireTenantPage("order:read");
  const board = await getOrderBoard(ctx, {});
  const canCreate = hasPermission(ctx, "order:create");
  // Record Payment on the board belongs to the simplified order workflow; with it off the board is unchanged.
  const canRecordPayment =
    hasPermission(ctx, "payment:record") && hasPermission(ctx, "transaction:read") && (await isSimplifiedWorkflowOn(ctx));
  // Open table bills (RASOIOS-ADR-027) carry amounts, so only roles that may see money get them.
  const openTables = hasPermission(ctx, "transaction:read") ? await listOpenTableBills(ctx) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Orders"
        description="Live board for today. New orders appear on their own."
        actions={
          canCreate ? (
            <Link
              href="/restaurant/orders/new"
              className="inline-flex h-12 items-center rounded-xl bg-action-primary px-5 text-subheading text-action-primary-fg transition-colors duration-fast ease-standard hover:bg-action-primary-hover"
            >
              New order
            </Link>
          ) : undefined
        }
      />
      <OrderBoard initial={board} transitions={allowedOrderTransitions(ctx)} timezone={ctx.restaurant.timezone} canCreate={canCreate} canRecordPayment={canRecordPayment} openTables={openTables} />
    </div>
  );
}
