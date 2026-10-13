"use client";

import * as React from "react";
import { Printer, RotateCcw } from "lucide-react";
import { getPaymentReceiptsAction, getSettlementAction, retryPaymentReceiptsAction, settleOrderAction } from "@/app/restaurant/orders/settle-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Form, SubmitButton } from "@/components/ui/form";
import { MoneyField } from "@/components/ui/inputs/decimal-field";
import { RadioGroup } from "@/components/ui/inputs/radio-group";
import { TextField } from "@/components/ui/inputs/text-field";
import type { ActionResult } from "@/lib/http/action";
import type { ReceiptCopyView, SettlementResult, SettlementView } from "@/lib/services/simplified-workflow";
import { moneyDifference } from "@/lib/ui/decimal-input";
import { formatMoney } from "@/lib/ui/format";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";

/**
 * Record Payment from the Orders board (simplified order workflow, owner brief 2026-10-13).
 *
 * One dialog, two states: the payment form, then what happened — the payment the server recorded, whether the order
 * was completed, and each receipt copy's live queue status. "Delivered" is the furthest it goes: the queue can confirm
 * the bytes reached the printer, never the paper (printing audit 2026-10-08 D3), so nothing here says "printed".
 *
 * The idempotency key is minted once per payment attempt and reused on retry, so a double click or a lost response
 * replays the same payment and the same receipt jobs instead of charging or printing twice (ADR-010 §7).
 */
const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
] as const;

export const RECEIPT_STATUS_LABEL: Record<ReceiptCopyView["status"], string> = {
  QUEUED: "Queued",
  PRINTING: "Sending",
  RETRYING: "Retrying",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const RECEIPT_STATUS_TONE: Record<ReceiptCopyView["status"], string> = {
  QUEUED: "text-fg-secondary",
  PRINTING: "text-fg-accent",
  RETRYING: "text-status-warning",
  DELIVERED: "text-status-success",
  FAILED: "text-status-danger",
  CANCELLED: "text-fg-secondary",
};

export const IN_FLIGHT: ReadonlySet<ReceiptCopyView["status"]> = new Set(["QUEUED", "PRINTING", "RETRYING"]);
export const RECEIPT_POLL_MS = 3_000;
/** Stop polling after this long; the Printing page keeps the full history. */
export const RECEIPT_POLL_LIMIT_MS = 120_000;

export function RecordPaymentDialog({ orderId, onClose, onSettled }: { orderId: string | null; onClose: () => void; onSettled: () => void }) {
  const [view, setView] = React.useState<SettlementView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SettlementResult | null>(null);

  React.useEffect(() => {
    setView(null);
    setLoadError(null);
    setResult(null);
    if (!orderId) return;
    let live = true;
    void getSettlementAction({ orderId }).then((res) => {
      if (!live) return;
      if (res.ok) setView(res.data as SettlementView);
      else setLoadError(res.error.message);
    });
    return () => {
      live = false;
    };
  }, [orderId]);

  const open = orderId !== null;
  const title = view ? `Record payment · ${view.orderNumber}` : "Record payment";
  const description = result
    ? "Payment recorded."
    : view?.balanceDue
      ? `Balance due ${formatMoney(view.balanceDue, view.currencyCode)}.`
      : undefined;

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} guardDirty={result === null}>
      {loadError ? (
        <div className="flex flex-col gap-4">
          <Alert tone="danger" title="This order can't take a payment here">
            {loadError}
          </Alert>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : !view ? (
        <p role="status" className="text-body text-fg-secondary">
          Loading the order…
        </p>
      ) : result ? (
        <SettlementOutcome orderId={view.orderId} currencyCode={view.currencyCode} result={result} onClose={onClose} />
      ) : (
        <PaymentForm
          view={view}
          onCancel={onClose}
          onDone={(settled) => {
            setResult(settled);
            onSettled();
          }}
        />
      )}
    </Dialog>
  );
}

function PaymentForm({ view, onCancel, onDone }: { view: SettlementView; onCancel: () => void; onDone: (result: SettlementResult) => void }) {
  const idempotency = useIdempotencyKey();
  const balance = view.balanceDue ?? "0.00";
  const [method, setMethod] = React.useState<string>("CASH");
  const [amount, setAmount] = React.useState<string | null>(balance);
  const [tendered, setTendered] = React.useState<string | null>(null);
  const change = method === "CASH" && tendered !== null && amount !== null ? moneyDifference(tendered, amount) : null;

  return (
    <Form
      action={(formData: FormData): Promise<ActionResult<unknown>> => {
        const text = (name: string) => String(formData.get(name) ?? "").trim();
        const chosen = text("method") || "CASH";
        const reference = text("reference");
        const tenderedValue = text("amountTendered");
        return settleOrderAction({
          orderId: view.orderId,
          idempotencyKey: idempotency.current(),
          method: chosen as never,
          amount: text("amount"),
          ...(chosen === "CASH" && tenderedValue !== "" ? { amountTendered: tenderedValue } : {}),
          ...(chosen !== "CASH" && reference !== "" ? { reference } : {}),
          // Sent only when the order has no customer; one on the order is shown, never replaced.
          ...(view.customer ? {} : { customer: { name: text("customer.name"), phone: text("customer.phone") } }),
        });
      }}
      onSuccess={(data) => {
        idempotency.reset();
        onDone(data as SettlementResult);
      }}
    >
      {view.customer ? (
        <div className="rounded-xl border border-border-subtle bg-raised p-3">
          <span className="block text-caption text-fg-secondary">Customer on this order</span>
          <span className="block text-label text-fg-primary">{view.customer.name}</span>
          {view.customer.phone && <span className="block text-caption tabular-nums text-fg-secondary">{view.customer.phone}</span>}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="customer.name" label="Customer name" autoComplete="off" maxLength={120} help="Optional. Needed for a new customer." />
          <TextField
            name="customer.phone"
            label="Customer phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            help="Optional. International format, e.g. +919876543210. A known number links that customer."
          />
        </div>
      )}

      <RadioGroup name="method" label="How is it being paid?" orientation="horizontal" value={method} onValueChange={setMethod} options={METHODS.map((m) => ({ value: m.value, label: m.label }))} />
      <MoneyField name="amount" label="Amount" required currencyCode={view.currencyCode} defaultValue={balance} onValueChange={setAmount} />

      {method === "CASH" ? (
        <>
          <MoneyField name="amountTendered" label="Cash handed over" currencyCode={view.currencyCode} onValueChange={setTendered} help="Leave empty if it is the exact amount." />
          <p role="status" aria-live="polite" className="min-h-6 text-body">
            {change === null ? null : change.startsWith("-") ? (
              <span className="text-status-danger">That is {formatMoney(change.slice(1), view.currencyCode)} short of the amount.</span>
            ) : (
              <span className="text-status-success">Change due {formatMoney(change, view.currencyCode)}</span>
            )}
          </p>
        </>
      ) : (
        <TextField
          name="reference"
          label={method === "UPI" ? "UPI reference" : "Card slip reference"}
          required={method === "UPI"}
          autoComplete="off"
          help="4–64 letters, digits or dashes. Never a card number."
        />
      )}

      <p className="text-caption text-fg-secondary">
        {view.completesOnPayment
          ? "Once paid in full, the order is completed and its receipt is sent to the receipt printer."
          : "Once paid in full, the receipt is sent to the receipt printer. The order completes from the board when it is ready."}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton loadingLabel="Recording payment…">Confirm payment</SubmitButton>
      </div>
    </Form>
  );
}

function SettlementOutcome({ orderId, currencyCode, result, onClose }: { orderId: string; currencyCode: string; result: SettlementResult; onClose: () => void }) {
  const { payment } = result;
  const [receipts, setReceipts] = React.useState<ReceiptCopyView[]>(result.receipts);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const startedAt = React.useRef(Date.now());

  const inFlight = receipts.some((copy) => IN_FLIGHT.has(copy.status));
  React.useEffect(() => {
    if (!inFlight || Date.now() - startedAt.current > RECEIPT_POLL_LIMIT_MS) return;
    const timer = setTimeout(() => {
      void getPaymentReceiptsAction({ orderId, transactionId: payment.transactionId }).then((res) => {
        if (res.ok) setReceipts(res.data as ReceiptCopyView[]);
      });
    }, RECEIPT_POLL_MS);
    return () => clearTimeout(timer);
  }, [inFlight, receipts, orderId, payment.transactionId]);

  const failed = receipts.some((copy) => copy.status === "FAILED");
  const settled = payment.paymentStatus === "PAID";
  // Nothing queued for a settled bill: no printer, automatic receipts off, or queueing failed — offer to print once.
  const canQueue = settled && receipts.length === 0 && result.receiptQueue !== "NO_PRINTER";

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    const res = await retryPaymentReceiptsAction({ orderId, transactionId: payment.transactionId });
    setRetrying(false);
    if (res.ok) {
      startedAt.current = Date.now();
      setReceipts(res.data as ReceiptCopyView[]);
    } else {
      setRetryError(res.error.message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success" title={payment.replayed ? "This payment was already recorded" : "Payment recorded"}>
        {formatMoney(payment.amount, currencyCode)} by {payment.method.toLowerCase()}
        {payment.changeDue && payment.changeDue !== "0.00" ? ` · change due ${formatMoney(payment.changeDue, currencyCode)}` : ""}
        {payment.balance !== "0.00" ? ` · ${formatMoney(payment.balance, currencyCode)} still due` : ""}
      </Alert>

      {result.completion === "COMPLETED" || result.completion === "ALREADY_COMPLETED" ? (
        <p className="text-body text-status-success">The order is completed.</p>
      ) : (
        result.completionMessage && <p className="text-body text-fg-secondary">{result.completionMessage}</p>
      )}

      <section aria-labelledby="receipt-status-heading" className="flex flex-col gap-2">
        <h3 id="receipt-status-heading" className="text-label text-fg-primary">
          Receipt
        </h3>
        {receipts.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border-subtle" aria-live="polite">
            {receipts.map((copy) => (
              <li key={copy.printJobId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-body text-fg-primary">{copy.copyLabel ?? (copy.copyCount && copy.copyCount > 1 ? `Copy ${copy.copyIndex}` : "Receipt")}</span>
                <span className={`text-label ${RECEIPT_STATUS_TONE[copy.status]}`}>{RECEIPT_STATUS_LABEL[copy.status]}</span>
                {copy.status === "FAILED" && copy.error && <span className="w-full text-caption text-fg-secondary">{copy.error}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-secondary">
            {!settled
              ? "The receipt is sent once the order is paid in full."
              : result.receiptQueue === "NO_PRINTER"
                ? "No receipt printer is set up, so nothing was sent."
                : result.receiptQueue === "FAILED"
                  ? "The payment is safe, but the receipt could not be queued."
                  : "No receipt was sent automatically."}
          </p>
        )}
        {(failed || canQueue) && (
          <div className="flex flex-col gap-2">
            {failed && <p className="text-caption text-fg-secondary">The payment is recorded. Retrying sends the same receipt again — it is never charged twice.</p>}
            <div>
              <Button variant="secondary" size="sm" icon={failed ? RotateCcw : Printer} loading={retrying} loadingLabel="Sending…" onClick={() => void retry()}>
                {failed ? "Retry receipt" : "Print receipt"}
              </Button>
            </div>
          </div>
        )}
        {retryError && <p className="text-caption text-status-danger">{retryError}</p>}
      </section>

      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
