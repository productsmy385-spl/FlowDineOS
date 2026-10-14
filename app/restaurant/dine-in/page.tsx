import { PageHeader } from "@/components/layout/page-header";
import { DineInTables } from "@/components/orders/dine-in-tables";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listDineInTables } from "@/lib/services/table-sessions";

export const dynamic = "force-dynamic";

/**
 * `/restaurant/dine-in` — the restaurant's tables and their open bills (owner brief 2026-10-14; RASOIOS-ADR-027),
 * `order:read`. Its own item in the console navigation, next to Orders. Each card opens the table's bill
 * (`/restaurant/orders/tables/[id]`, which the navigation counts as Dine-in) or starts / adds an order for the table.
 * Amounts only for roles holding `transaction:read`; the grid refreshes itself every 10 s.
 */
export default async function DineInPage() {
  const ctx = await requireTenantPage("order:read");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dine-in" description="Tables and their open bills. Updates on its own." />
      <DineInTables
        initial={await listDineInTables(ctx)}
        currencyCode={ctx.restaurant.currencyCode}
        can={{ createOrder: hasPermission(ctx, "order:create"), viewBill: hasPermission(ctx, "transaction:read") }}
      />
    </div>
  );
}
