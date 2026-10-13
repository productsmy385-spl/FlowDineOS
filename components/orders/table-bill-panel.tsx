"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Printer, RefreshCw, RotateCcw, Wallet, XCircle } from "lucide-react";
import {
  closeTableBillAction,
  getTableBillAction,
  getTableBillReceiptsAction,
  payTableBillAction,
  retryTableBillReceiptsAction,
} from "@/app/restaurant/orders/table-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Form, SubmitButton } from "@/components/ui/form";
import { MoneyField } from "@/components/ui/inputs/decimal-field";
import { RadioGroup } from "@/components/ui/inputs/radio-group";
import { TextField } from "@/components/ui/inputs/text-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/http/action";
import type { ReceiptCopyView } from "@/lib/services/simplified-workflow";
import type { TableBillSettlement, TableBillState, TableBillView } from "@/lib/services/table-sessions";
import { moneyDifference } from "@/lib/ui/decimal-input";
import { formatInZone, formatMoney } from "@/lib/ui/format";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { IN_FLIGHT, RECEIPT_POLL_LIMIT_MS, RECEIPT_POLL_MS, RECEIPT_STATUS_LABEL, RECEIPT_STATUS_TONE } from "./record-payment-dialog";

/**
 * One table's bill (RASOIOS-ADR-027): every order the party placed, the bill as one list of what they had, what has
 * been paid and what is due — and from here, add another order, take payment for the whole table, or close it.
 *
 * Nothing about money is worked out here. Every figure is the server's (`getTableBillAction`), the payment is checked
 * against the bill version on screen, and if the bill changed in the meantime the server refuses and the screen shows
 * the new bill instead of collecting the old total.
 */
export const BILL_STATE_LABEL: Record<TableBillState, string> = {
  OPEN: "Open",
  PREPARING: "Preparing",
  READY: "Ready",
  PARTIALLY_PAID: "Partially paid",
  PAYMENT_PENDING: "Payment pending",
  SETTLED: "Settled",
  CLOSED: "Closed",
};

const BILL_STATE_TONE: Record<TableBillState, string> = {
  OPEN: "border-border-strong text-fg-secondary",
  PREPARING: "border-status-warning text-status-warning",
  READY: "border-status-success text-status-success",
  PARTIALLY_PAID: "border-status-warning text-status-warning",
  PAYMENT_PENDING: "border-action-primary text-fg-accent",
  SETTLED: "border-status-success text-status-success",
  CLOSED: "border-border-strong text-fg-secondary",
};

export function BillStateChip({ state }: { state: TableBillState }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-caption font-medium ${BILL_STATE_TONE[state]}`}>{BILL_STATE_LABEL[state]}</span>;
}

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
] as const;

const POLL_MS = 10_000;

export function TableBillPanel({
  initial,
  timezone,
  can,
}: {
  initial: TableBillView;
  timezone: string;
  can: { pay: boolean; addOrder: boolean; retryReceipt: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [bill, setBill] = React.useState(initial);
  const [paying, setPaying] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [settlement, setSettlement] = React.useState<TableBillSettlement | null>(null);
  const money = (amount: string) => formatMoney(amount, bill.currencyCode);
  const open = bill.status === "OPEN";

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    const result = await getTableBillAction({ tableSessionId: initial.id });
    setRefreshing(false);
    if (result.ok) setBill(result.data as TableBillView);
    return result.ok ? (result.data as TableBillView) : null;
  }, [initial.id]);

  // An open bill can grow from another till or the kitchen can move its orders: keep it current while it is on screen.
  React.useEffect(() => {
    if (!open || paying) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, paying, refresh]);

  async function closeBill() {
    setClosing(true);
    const result = await closeTableBillAction({ tableSessionId: bill.id, expectedVersion: bill.version });
    setClosing(false);
    if (result.ok) {
      setBill(result.data as TableBillView);
      toast.success(`Bill ${bill.billNumber} closed.`);
      router.refresh();
    } else {
      toast.error(result.error.message);
      void refresh();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Bill</CardTitle>
          </CardHeader>
          {bill.lines.length === 0 ? (
            <p className="text-body text-fg-secondary">Nothing on this bill yet.</p>
          ) : (
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[480px] text-body">
                <caption className="sr-only">Everything the table has ordered, as one bill</caption>
                <thead>
                  <tr className="border-b border-border-subtle text-left text-caption text-fg-secondary">
                    <th scope="col" className="py-2 pr-3 font-medium">Item</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Qty</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Price</th>
                    <th scope="col" className="py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.lines.map((line, index) => (
                    <tr key={`${line.name}-${line.unitPrice}-${index}`} className="border-b border-border-subtle align-top">
                      <td className="py-2 pr-3">
                        <span className="block text-fg-primary">{line.name}</span>
                        <span className="block text-caption text-fg-secondary">Order {line.orders.join(", ")}</span>
                      </td>
                      <td className="py-2 pr-3 text-right text-numeric text-fg-primary">{line.quantity}</td>
                      <td className="py-2 pr-3 text-right text-numeric text-fg-secondary">{money(line.unitPrice)}</td>
                      <td className="py-2 text-right text-numeric text-fg-primary">{money(line.lineSubtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <BillTotals bill={bill} />
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Orders on this bill</CardTitle>
          </CardHeader>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {bill.orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <Link href={`/restaurant/orders/${order.id}`} className="text-label text-numeric text-fg-accent hover:underline">
                  {order.orderNumber}
                </Link>
                <StatusBadge domain="order" status={order.status} />
                <span className="text-caption text-fg-secondary">
                  {formatInZone(order.createdAt, timezone, "time")}
                  {order.kots.length > 0 ? ` · KOT ${order.kots.map((k) => k.kotNumber).join(", ")}` : ""}
                </span>
                <span className="ml-auto text-numeric text-fg-primary">{order.billed ? money(order.total) : "Not billed"}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="flex flex-col gap-4 lg:gap-6">
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-subheading text-fg-primary">Balance due</span>
              <span className="text-heading text-numeric text-fg-primary">{money(bill.totals.balance)}</span>
            </div>
            {bill.customers.length > 0 && (
              <p className="text-caption text-fg-secondary">Customer: {bill.customers.map((c) => c.name).join(", ")}</p>
            )}
            <div className="flex flex-col gap-2">
              {open && can.pay && bill.totals.balance !== "0.00" && (
                <Button icon={Wallet} size="touch" className="w-full" onClick={() => setPaying(true)}>
                  Record Payment
                </Button>
              )}
              {open && can.addOrder && (
                <Link
                  href={`/restaurant/orders/new?table=${encodeURIComponent(bill.tableLabel)}`}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border-strong text-subheading text-fg-primary hover:bg-raised"
                >
                  <Plus className="size-4" aria-hidden />
                  Add order to this table
                </Link>
              )}
              {bill.canClose && can.pay && (
                <Button variant="secondary" icon={XCircle} loading={closing} loadingLabel="Closing…" onClick={() => void closeBill()}>
                  Close table
                </Button>
              )}
              <Button variant="ghost" icon={RefreshCw} loading={refreshing} loadingLabel="Refreshing…" onClick={() => void refresh()}>
                Refresh bill
              </Button>
            </div>
            {!open && <p className="text-caption text-fg-secondary">This bill is closed. A new order for table {bill.tableLabel} starts a new bill.</p>}
          </div>
        </Card>

        {bill.payments.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
            </CardHeader>
            <ul className="flex flex-col divide-y divide-border-subtle">
              {bill.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className={`min-w-0 flex-1 text-label ${p.active ? "text-fg-primary" : "text-fg-secondary line-through"}`}>
                    {METHODS.find((m) => m.value === p.method)?.label ?? p.method}
                    {p.reference ? ` · ${p.reference}` : ""}
                    <span className="block text-caption text-fg-secondary">{formatInZone(p.createdAt, timezone, "time")}</span>
                  </span>
                  <span className="text-numeric text-fg-primary">{money(p.amount)}</span>
                  {p.changeDue && p.changeDue !== "0.00" && <span className="w-full text-caption text-fg-secondary">Change {money(p.changeDue)}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {settlement && <PaymentOutcome settlement={settlement} currencyCode={bill.currencyCode} canRetry={can.retryReceipt} onDismiss={() => setSettlement(null)} />}
      </div>

      {can.pay && (
        <TablePaymentDialog
          open={paying}
          bill={bill}
          onClose={() => setPaying(false)}
          onBillChanged={async () => (await refresh()) ?? bill}
          onSettled={(result) => {
            setPaying(false);
            setBill(result.bill);
            setSettlement(result);
            toast.success(result.payment.closed ? `Bill ${bill.billNumber} settled.` : "Payment recorded.");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function BillTotals({ bill }: { bill: TableBillView }) {
  const money = (amount: string) => formatMoney(amount, bill.currencyCode);
  const row = (term: string, value: string, strong = false) => (
    <div className="flex justify-between gap-4">
      <dt className={strong ? "text-subheading text-fg-primary" : "text-body text-fg-secondary"}>{term}</dt>
      <dd className={`text-numeric ${strong ? "text-subheading text-fg-primary" : "text-body text-fg-primary"}`}>{value}</dd>
    </div>
  );
  return (
    <dl className="mt-4 flex flex-col gap-1 border-t border-border-subtle pt-3">
      {row("Subtotal", money(bill.totals.subtotal))}
      {bill.totals.discount !== "0.00" && row("Discount", `− ${money(bill.totals.discount)}`)}
      {row("Tax", money(bill.totals.tax))}
      {row("Total", money(bill.totals.total), true)}
      {bill.totals.paid !== "0.00" && row("Paid", money(bill.totals.paid))}
      {bill.totals.refunded !== "0.00" && row("Refunded", money(bill.totals.refunded))}
      {row("Balance due", money(bill.totals.balance), true)}
    </dl>
  );
}

function TablePaymentDialog({
  open,
  bill,
  onClose,
  onBillChanged,
  onSettled,
}: {
  open: boolean;
  bill: TableBillView;
  onClose: () => void;
  onBillChanged: () => Promise<TableBillView>;
  onSettled: (result: TableBillSettlement) => void;
}) {
  const idempotency = useIdempotencyKey();
  const [method, setMethod] = React.useState<string>("CASH");
  const [amount, setAmount] = React.useState<string | null>(bill.totals.balance);
  const [tendered, setTendered] = React.useState<string | null>(null);
  const [changedNote, setChangedNote] = React.useState<string | null>(null);
  // The form is remounted with the new balance when the bill changes, so the amount field starts from it.
  const [formKey, setFormKey] = React.useState(0);

  React.useEffect(() => {
    if (open) {
      setMethod("CASH");
      setAmount(bill.totals.balance);
      setTendered(null);
      setChangedNote(null);
    }
    // Only when the dialog opens; a bill change while open is handled explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const change = method === "CASH" && tendered !== null && amount !== null ? moneyDifference(tendered, amount) : null;
  const money = (value: string) => formatMoney(value, bill.currencyCode);

  return (
    <Dialog open={open} onClose={onClose} title={`Record payment · Table ${bill.tableLabel}`} description={`Bill ${bill.billNumber} · ${money(bill.totals.balance)} due`}>
      <div className="flex flex-col gap-4">
        {changedNote && (
          <Alert tone="warning" title="The bill changed">
            {changedNote}
          </Alert>
        )}
        <details className="rounded-xl border border-border-subtle p-3" open>
          <summary className="cursor-pointer text-label text-fg-primary">
            {bill.lines.reduce((n, l) => n + l.quantity, 0)} items from {bill.orders.filter((o) => o.billed).length} orders
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {bill.lines.map((line, index) => (
              <li key={`${line.name}-${index}`} className="flex justify-between gap-3 text-body">
                <span className="text-fg-primary">
                  {line.quantity} × {line.name} <span className="text-caption text-fg-secondary">@ {money(line.unitPrice)}</span>
                </span>
                <span className="text-numeric text-fg-primary">{money(line.lineSubtotal)}</span>
              </li>
            ))}
          </ul>
          <BillTotals bill={bill} />
        </details>

        <Form
          key={formKey}
          action={(formData: FormData): Promise<ActionResult<unknown>> => {
            const text = (name: string) => String(formData.get(name) ?? "").trim();
            const chosen = text("method") || "CASH";
            const reference = text("reference");
            const tenderedValue = text("amountTendered");
            return payTableBillAction({
              tableSessionId: bill.id,
              idempotencyKey: idempotency.current(),
              expectedVersion: bill.version,
              method: chosen as never,
              amount: text("amount"),
              ...(chosen === "CASH" && tenderedValue !== "" ? { amountTendered: tenderedValue } : {}),
              ...(chosen !== "CASH" && reference !== "" ? { reference } : {}),
              // Asked only when no order on the bill has a customer; an existing one is shown, never replaced.
              ...(bill.customers.length > 0 ? {} : { customer: { name: text("customer.name"), phone: text("customer.phone") } }),
            }).then(async (result) => {
              if (!result.ok && (result.error.code === "BILL_CHANGED" || result.error.code === "TABLE_BILL_CLOSED")) {
                // Never collect a total the cashier did not see: show the new bill and let them confirm again.
                const fresh = await onBillChanged();
                idempotency.reset();
                setAmount(fresh.totals.balance);
                setFormKey((k) => k + 1);
                setChangedNote(`${result.error.message} The bill now comes to ${money(fresh.totals.balance)}.`);
              }
              return result;
            });
          }}
          onSuccess={(data) => {
            idempotency.reset();
            onSettled(data as TableBillSettlement);
          }}
        >
          {bill.customers.length > 0 ? (
            <p className="text-body text-fg-secondary">Customer: {bill.customers.map((c) => c.name).join(", ")}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="customer.name" label="Customer name" autoComplete="off" maxLength={120} help="Optional." />
              <TextField name="customer.phone" label="Customer phone" type="tel" inputMode="tel" autoComplete="off" help="Optional. e.g. +919876543210" />
            </div>
          )}

          <RadioGroup name="method" label="How is it being paid?" orientation="horizontal" value={method} onValueChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} />
          <MoneyField name="amount" label="Amount" required currencyCode={bill.currencyCode} defaultValue={bill.totals.balance} onValueChange={setAmount} help="Less than the balance records a part payment." />

          {method === "CASH" ? (
            <>
              <MoneyField name="amountTendered" label="Cash handed over" currencyCode={bill.currencyCode} onValueChange={setTendered} help="Leave empty if it is the exact amount." />
              <p role="status" aria-live="polite" className="min-h-6 text-body">
                {change === null ? null : change.startsWith("-") ? (
                  <span className="text-status-danger">That is {money(change.slice(1))} short of the amount.</span>
                ) : (
                  <span className="text-status-success">Change due {money(change)}</span>
                )}
              </p>
            </>
          ) : (
            <TextField name="reference" label={method === "UPI" ? "UPI reference" : "Card slip reference"} required={method === "UPI"} autoComplete="off" help="4–64 letters, digits or dashes. Never a card number." />
          )}

          <p className="text-caption text-fg-secondary">When the bill is paid in full, ready orders are completed and one receipt for the whole table is sent to the receipt printer.</p>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton loadingLabel="Recording payment…">Confirm payment</SubmitButton>
          </div>
        </Form>
      </div>
    </Dialog>
  );
}

function PaymentOutcome({ settlement, currencyCode, canRetry, onDismiss }: { settlement: TableBillSettlement; currencyCode: string; canRetry: boolean; onDismiss: () => void }) {
  const { payment } = settlement;
  const [receipts, setReceipts] = React.useState<ReceiptCopyView[]>(settlement.receipts);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const startedAt = React.useRef(Date.now());
  const money = (value: string) => formatMoney(value, currencyCode);

  const inFlight = receipts.some((copy) => IN_FLIGHT.has(copy.status));
  React.useEffect(() => {
    if (!inFlight || Date.now() - startedAt.current > RECEIPT_POLL_LIMIT_MS) return;
    const timer = setTimeout(() => {
      void getTableBillReceiptsAction({ paymentId: payment.paymentId }).then((res) => {
        if (res.ok) setReceipts(res.data as ReceiptCopyView[]);
      });
    }, RECEIPT_POLL_MS);
    return () => clearTimeout(timer);
  }, [inFlight, receipts, payment.paymentId]);

  const failed = receipts.some((copy) => copy.status === "FAILED");
  const canQueue = payment.closed && receipts.length === 0 && settlement.receiptQueue !== "NO_PRINTER";

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    const res = await retryTableBillReceiptsAction({ paymentId: payment.paymentId });
    setRetrying(false);
    if (res.ok) {
      startedAt.current = Date.now();
      setReceipts(res.data as ReceiptCopyView[]);
    } else setRetryError(res.error.message);
  }

  const notCompleted = settlement.completions.filter((c) => c.completion !== "COMPLETED" && c.completion !== "ALREADY_COMPLETED");

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Alert tone="success" title={payment.replayed ? "This payment was already recorded" : payment.closed ? "Bill settled" : "Payment recorded"}>
          {money(payment.amount)} by {payment.method.toLowerCase()}
          {payment.changeDue && payment.changeDue !== "0.00" ? ` · change due ${money(payment.changeDue)}` : ""}
          {payment.balance !== "0.00" ? ` · ${money(payment.balance)} still due` : ""}
        </Alert>
        {notCompleted.length > 0 && (
          <p className="text-caption text-fg-secondary">
            Still open: {notCompleted.map((c) => `${c.orderNumber} (${c.message ?? c.completion.toLowerCase()})`).join("; ")}
          </p>
        )}
        <section aria-labelledby="table-receipt-heading" className="flex flex-col gap-2">
          <h3 id="table-receipt-heading" className="text-label text-fg-primary">
            Receipt
          </h3>
          {receipts.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border-subtle" aria-live="polite">
              {receipts.map((copy) => (
                <li key={copy.printJobId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-body text-fg-primary">{copy.copyLabel ?? "Receipt"}</span>
                  <span className={`text-label ${RECEIPT_STATUS_TONE[copy.status]}`}>{RECEIPT_STATUS_LABEL[copy.status]}</span>
                  {copy.status === "FAILED" && copy.error && <span className="w-full text-caption text-fg-secondary">{copy.error}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-fg-secondary">
              {!payment.closed
                ? "The receipt prints once the bill is paid in full."
                : settlement.receiptQueue === "NO_PRINTER"
                  ? "No receipt printer is set up, so nothing was sent."
                  : settlement.receiptQueue === "FAILED"
                    ? "The payment is safe, but the receipt could not be queued."
                    : "No receipt was sent automatically."}
            </p>
          )}
          {canRetry && (failed || canQueue) && (
            <div>
              <Button variant="secondary" size="sm" icon={failed ? RotateCcw : Printer} loading={retrying} loadingLabel="Sending…" onClick={() => void retry()}>
                {failed ? "Retry receipt" : "Print receipt"}
              </Button>
            </div>
          )}
          {retryError && <p className="text-caption text-status-danger">{retryError}</p>}
        </section>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Card>
  );
}
