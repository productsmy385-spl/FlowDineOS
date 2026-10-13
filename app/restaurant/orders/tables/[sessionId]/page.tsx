import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { ForbiddenState } from "@/components/states/access-states";
import { PageHeader } from "@/components/layout/page-header";
import { BillStateChip, TableBillPanel } from "@/components/orders/table-bill-panel";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/errors";
import { getTableBill } from "@/lib/services/table-sessions";
import { formatInZone } from "@/lib/ui/format";
import { parseParamOrNotFound, uuidParam } from "@/lib/validation/core";

export const dynamic = "force-dynamic";

/**
 * `/restaurant/orders/tables/[sessionId]` — one table's bill (RASOIOS-ADR-027), `order:read` + `transaction:read`.
 * A bill of another restaurant renders the same not-found page as an unknown id (SC-TEN-04). Every figure is the
 * server's; the panel offers only what the role may do, and the server checks each request again.
 */
export default async function TableBillPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const ctx = await requireTenantPage("order:read");
  if (!hasPermission(ctx, "transaction:read")) {
    return (
      <Card>
        <ForbiddenState />
      </Card>
    );
  }
  const { sessionId } = await params;
  const id = parseParamOrNotFound(uuidParam, sessionId);
  const bill = await getTableBill(ctx, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Table ${bill.tableLabel}`}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-numeric">Bill {bill.billNumber}</span>
            <BillStateChip state={bill.state} />
            <span>Opened {formatInZone(bill.openedAt, ctx.restaurant.timezone, "time")}</span>
            <Link href="/restaurant/orders" className="text-fg-accent hover:underline">
              Back to orders
            </Link>
          </span>
        }
      />
      <TableBillPanel
        initial={bill}
        timezone={ctx.restaurant.timezone}
        can={{
          pay: hasPermission(ctx, "payment:record"),
          addOrder: hasPermission(ctx, "order:create"),
          retryReceipt: hasPermission(ctx, "print_job:retry"),
        }}
      />
    </div>
  );
}
