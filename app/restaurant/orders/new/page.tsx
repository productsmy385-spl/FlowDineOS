import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ForbiddenState } from "@/components/states/access-states";
import { PageHeader } from "@/components/layout/page-header";
import { OrderEntry } from "@/components/orders/order-entry";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/errors";
import { getOrderEntryCatalogue } from "@/lib/services/orders";
import { getTableBillSummary } from "@/lib/services/table-sessions";
import { uuidParam } from "@/lib/validation/core";

export const dynamic = "force-dynamic";

const ORDER_TYPES = ["DINE_IN", "TAKEAWAY", "DELIVERY"] as const;
const DINE_IN_HREF = "/restaurant/dine-in";

/**
 * LD-ORD-03 — `/restaurant/orders/new` (S1-P12-T007). `order:create` opens the screen and `menu:read` fills it; both
 * are the server's decision, and SA-ORD-01 checks them again when the order is saved. Sending straight to the kitchen
 * additionally needs `order:accept`, and adding a new customer `customer:create`, so the form offers each control
 * only to a role that holds it (SC-RBAC-08 — the server still enforces it).
 *
 * Query (display hints only — the server decides everything when the order is placed):
 * - `?bill=<id>` — "+ Add Items" to an open table bill (RASOIOS-ADR-027): the order is placed for that bill only, and
 *   refused if the bill was settled or closed in the meantime;
 * - `?table=<label>` — start an order for a table (a new bill, or the table's open one);
 * - `?type=TAKEAWAY|DELIVERY|DINE_IN` — the order type to start with.
 */
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ table?: string | string[]; bill?: string | string[]; type?: string | string[] }> }) {
  const ctx = await requireTenantPage("order:create");
  const params = (await searchParams) ?? {};
  if (!hasPermission(ctx, "menu:read")) {
    return (
      <Card>
        <ForbiddenState />
      </Card>
    );
  }

  const billParam = typeof params.bill === "string" ? params.bill : null;
  if (billParam !== null) {
    const parsed = uuidParam.safeParse(billParam);
    const bill = parsed.success
      ? await getTableBillSummary(ctx, parsed.data).catch((error) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        })
      : null;
    if (!bill || !bill.open) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title="Add items" />
          <Alert tone="warning" title={bill ? `Table ${bill.tableLabel}'s bill ${bill.billNumber} is closed` : "This table bill was not found"}>
            {bill ? "It was settled or closed, so nothing more can be added to it. Choose the table again to start a new bill." : "Go back to Dine-in and choose the table again."}
          </Alert>
          <BackToDineIn />
        </div>
      );
    }
    const catalogue = await getOrderEntryCatalogue(ctx);
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Add items · Table ${bill.tableLabel}`}
          description={
            <span>
              New order on bill <span className="text-numeric">{bill.billNumber}</span>. It gets its own KOT; the table keeps one bill.
            </span>
          }
          actions={<BackToDineIn />}
        />
        <OrderEntry
          catalogue={catalogue}
          canSendToKitchen={hasPermission(ctx, "order:accept")}
          canSetPriority={ctx.role === "TENANT_ADMIN" || ctx.role === "MANAGER" || ctx.role === "CASHIER"}
          canCreateCustomer={hasPermission(ctx, "customer:create")}
          addToBill={{ ...bill, canViewBill: hasPermission(ctx, "transaction:read") }}
        />
      </div>
    );
  }

  // "Start Order" on a table card opens this page with the table filled in.
  const initialTable = typeof params.table === "string" ? params.table.trim().slice(0, 20) : "";
  const initialType = ORDER_TYPES.find((type) => type === params.type);
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
        initialType={initialType}
      />
    </div>
  );
}

function BackToDineIn() {
  return (
    <Link href={DINE_IN_HREF} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border-strong px-4 text-label text-fg-primary hover:bg-raised">
      <ArrowLeft className="size-4" aria-hidden />
      Back to Dine-in
    </Link>
  );
}
