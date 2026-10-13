import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/states/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { OrderCustomerPanel } from "@/components/orders/order-customer-panel";
import { OrderDetailActions } from "@/components/orders/order-detail-actions";
import { OrderLinesTable } from "@/components/orders/order-lines-table";
import { OrderTimeline } from "@/components/orders/order-timeline";
import { ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, PRIORITY_LABELS } from "@/components/orders/order-labels";
import { PaymentPanel } from "@/components/transactions/payment-panel";
import { requireTenantPage } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import type { TransactionListItem } from "@/lib/data/transactions";
import { listTransactions } from "@/lib/data/transactions";
import { NotFoundError } from "@/lib/errors";
import { getOrderDetail } from "@/lib/services/orders";
import { formatBusinessDate, formatInZone, formatMoney } from "@/lib/ui/format";
import { DOMAIN_ICONS } from "@/lib/ui/icons";
import { parseParamOrNotFound } from "@/lib/validation/core";
import { uuidParam } from "@/lib/validation/core";

export const dynamic = "force-dynamic";

function Stamp({ label, iso, timezone }: { label: string; iso: string | null; timezone: string }) {
  if (!iso) return null;
  return (
    <div>
      <dt className="text-caption text-fg-secondary">{label}</dt>
      <dd className="text-body text-numeric text-fg-primary">
        <time dateTime={iso} title={iso}>
          {formatInZone(iso, timezone, "time")}
        </time>
      </dd>
    </div>
  );
}

function money(amount: string | null, currencyCode: string): string {
  return amount === null ? "—" : formatMoney(amount, currencyCode);
}

/**
 * LD-ORD-02 — `/restaurant/orders/[orderId]` (S1-P12-T009, `order:read`). Everything on this page is the server's
 * answer for this caller: the lines are the order's own immutable snapshots, the actions are the ones the role may
 * request (SA-ORD-02/03/05/06), and an order of another restaurant renders the same not-found page as an unknown id
 * (SC-TEN-04). KITCHEN sees the work without the customer or the money.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const ctx = await requireTenantPage("order:read");
  const { orderId } = await params;
  const id = parseParamOrNotFound(uuidParam, orderId);

  const view = await getOrderDetail(ctx, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { order, timeline, allowedActions } = view;
  // This order's own ledger, for the payment panel. Only for roles that may see money — the loader already decided
  // that, and asking for it otherwise would be reading what the projection deliberately withheld.
  const ledger: TransactionListItem[] = view.canSeeMoney ? (await listTransactions(ctx, { orderId: order.id, limit: 50 })).items : [];
  const timezone = ctx.restaurant.timezone;
  const TypeIcon = ORDER_TYPE_ICONS[order.orderType];
  const showMoney = order.totalAmount !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Order ${order.orderNumber}`}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={TypeIcon} size={16} />
              {ORDER_TYPE_LABELS[order.orderType]}
            </span>
            {order.tableLabel && <span>Table {order.tableLabel}</span>}
            {order.tableBill && <span>Bill {order.tableBill.billNumber}</span>}
            <span>{formatBusinessDate(order.businessDate)}</span>
            <span>Priority: {PRIORITY_LABELS[order.priority]}</span>
          </span>
        }
        actions={
          <Link href="/restaurant/orders" className="text-label text-fg-accent hover:underline">
            Back to the board
          </Link>
        }
      />

      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge domain="order" status={order.status} />
            {order.paymentStatus && <StatusBadge domain="payment" status={order.paymentStatus} />}
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Stamp label="Placed" iso={order.createdAt} timezone={timezone} />
            <Stamp label="Accepted" iso={order.acceptedAt} timezone={timezone} />
            <Stamp label="Preparing" iso={order.preparingAt} timezone={timezone} />
            <Stamp label="Ready" iso={order.readyAt} timezone={timezone} />
            <Stamp label="Completed" iso={order.completedAt} timezone={timezone} />
            <Stamp label="Cancelled" iso={order.cancelledAt} timezone={timezone} />
          </dl>
          {order.cancelReason && (
            <p className="text-body text-fg-secondary">
              Cancelled{order.cancelledByName ? ` by ${order.cancelledByName}` : ""}: {order.cancelReason}
            </p>
          )}
          {order.notes && <p className="border-l-2 border-status-warning pl-3 text-body text-fg-primary">{order.notes}</p>}
          <OrderDetailActions
            orderId={order.id}
            orderNumber={order.orderNumber}
            version={order.version}
            priority={order.priority}
            allowedActions={allowedActions}
          />
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="flex flex-col gap-4 lg:col-span-2 lg:gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <OrderLinesTable order={order} />
            {showMoney && (
              <dl className="mt-4 flex flex-col gap-2 border-t border-border-subtle pt-4">
                <div className="flex justify-between gap-4">
                  <dt className="text-body text-fg-secondary">Subtotal</dt>
                  <dd className="text-body text-numeric text-fg-primary">{money(order.subtotalAmount, order.currencyCode)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-body text-fg-secondary">Tax</dt>
                  <dd className="text-body text-numeric text-fg-primary">{money(order.taxAmount, order.currencyCode)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-subheading text-fg-primary">Total</dt>
                  <dd className="text-subheading text-numeric text-fg-primary">{money(order.totalAmount, order.currencyCode)}</dd>
                </div>
              </dl>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Kitchen tickets</CardTitle>
            </CardHeader>
            {order.kots.length === 0 ? (
              <EmptyState
                icon={DOMAIN_ICONS.kot}
                title="No kitchen tickets yet"
                description="Tickets are created when the order is accepted and sent to the kitchen."
              />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {order.kots.map((kot) => (
                  <li key={kot.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-label text-numeric text-fg-primary">
                        KOT {kot.kotNumber}
                        {kot.roundNumber > 1 ? ` · round ${kot.roundNumber}` : ""}
                      </span>
                      <span className="block text-caption text-fg-secondary">
                        {kot.sectionName ?? "No section"} · {kot.itemCount} {kot.itemCount === 1 ? "line" : "lines"} ·{" "}
                        <time dateTime={kot.queuedAt} title={kot.queuedAt}>
                          {formatInZone(kot.queuedAt, timezone, "time")}
                        </time>
                      </span>
                    </span>
                    <StatusBadge domain="kot" status={kot.status} />
                    {kot.printStatus === "NOT_REQUESTED" ? (
                      <span className="text-caption text-fg-secondary">Not printed (sent to screen)</span>
                    ) : (
                      kot.printStatus !== "NONE" && <StatusBadge domain="printJob" status={kot.printStatus} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:gap-6">
          {/* api.md LD-ORD-02: the payment panel is for roles holding `transaction:read`. A waiter still sees the
              order total on the lines above — they have to tell the guest what to pay — but not the ledger state. */}
          {view.canSeeMoney && (
            <Card>
              <CardHeader>
                <CardTitle>Payment</CardTitle>
              </CardHeader>
              {order.tableBill && (
                <p className="mb-3 text-body text-fg-secondary">
                  {order.tableBill.open ? "Paid with " : "Was paid with "}
                  <Link href={`/restaurant/orders/tables/${order.tableBill.id}`} className="text-fg-accent hover:underline">
                    table {order.tableBill.tableLabel}&apos;s bill {order.tableBill.billNumber}
                  </Link>
                  {order.tableBill.open ? " — take payment there, for the whole table." : "."}
                </p>
              )}
              <PaymentPanel
                orderId={order.id}
                orderNumber={order.orderNumber}
                currencyCode={order.currencyCode}
                paidAmount={order.paidAmount}
                refundedAmount={order.refundedAmount}
                balanceDue={order.balanceDue}
                paymentStatus={order.paymentStatus}
                ledger={ledger}
                can={{
                  // An order on an open table bill is paid with the bill (RASOIOS-ADR-027); the server refuses it here too.
                  recordPayment: hasPermission(ctx, "payment:record") && !order.tableBill?.open,
                  refund: hasPermission(ctx, "refund:create"),
                  complete: allowedActions.includes("COMPLETED"),
                }}
              />
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            {order.customer === null && !allowedActions.includes("SET_CUSTOMER") ? (
              <p className="text-body text-fg-secondary">No customer linked to this order.</p>
            ) : (
              <OrderCustomerPanel orderId={order.id} customer={order.customer} canEdit={allowedActions.includes("SET_CUSTOMER")} />
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            {timeline.length === 0 ? (
              <p className="text-body text-fg-secondary">Nothing recorded for this order yet.</p>
            ) : (
              <OrderTimeline entries={timeline} timezone={timezone} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
