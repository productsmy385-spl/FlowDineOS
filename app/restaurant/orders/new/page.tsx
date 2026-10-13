import { Card } from "@/components/ui/card";
import { ForbiddenState } from "@/components/states/access-states";
import { PageHeader } from "@/components/layout/page-header";
import { OrderEntry } from "@/components/orders/order-entry";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getOrderEntryCatalogue } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

/**
 * LD-ORD-03 — `/restaurant/orders/new` (S1-P12-T007). `order:create` opens the screen and `menu:read` fills it; both
 * are the server's decision, and SA-ORD-01 checks them again when the order is saved. Sending straight to the kitchen
 * additionally needs `order:accept`, and adding a new customer `customer:create`, so the form offers each control
 * only to a role that holds it (SC-RBAC-08 — the server still enforces it).
 */
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ table?: string | string[] }> }) {
  const ctx = await requireTenantPage("order:create");
  // "Add order" on a table bill opens this page with the table filled in (RASOIOS-ADR-027). Display text only: the
  // server decides which bill the order joins when it is placed.
  const tableParam = (await searchParams)?.table;
  const initialTable = typeof tableParam === "string" ? tableParam.trim().slice(0, 20) : "";
  if (!hasPermission(ctx, "menu:read")) {
    return (
      <Card>
        <ForbiddenState />
      </Card>
    );
  }

  const catalogue = await getOrderEntryCatalogue(ctx);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New order" description="Tap items to build the order. Totals are priced by the server." />
      <OrderEntry
        catalogue={catalogue}
        canSendToKitchen={hasPermission(ctx, "order:accept")}
        canSetPriority={ctx.role === "TENANT_ADMIN" || ctx.role === "MANAGER" || ctx.role === "CASHIER"}
        canCreateCustomer={hasPermission(ctx, "customer:create")}
        initialTable={initialTable}
      />
    </div>
  );
}
