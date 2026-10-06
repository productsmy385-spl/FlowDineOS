"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BadgeCheck, Undo2, Wallet } from "lucide-react";
import { createRefundAction, recordPaymentAction } from "@/app/restaurant/transactions/actions";
import { updateOrderStatusAction } from "@/app/restaurant/orders/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Form, SubmitButton } from "@/components/ui/form";
import { MoneyField } from "@/components/ui/inputs/decimal-field";
import { RadioGroup } from "@/components/ui/inputs/radio-group";
import { TextArea } from "@/components/ui/inputs/text-area";
import { TextField } from "@/components/ui/inputs/text-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";

/** What a payment did about the receipt, as reported by the server (`ReceiptQueueOutcome`). */
type ReceiptStatus = "QUEUED" | "NO_PRINTER" | "FAILED" | "NOT_REQUESTED";
import type { TransactionListItem } from "@/lib/data/transactions";
import type { ActionResult } from "@/lib/http/action";
import { moneyDifference } from "@/lib/ui/decimal-input";
import { formatMoney } from "@/lib/ui/format";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";

/**
 * Taking money for one order, where the order is handled (S1-P18-T006; api.md SA-TXN-01, SA-TXN-02, SA-ORD-02).
 *
 * Every amount here is a decimal string from keystroke to server (ADR-010 §1) — the change due is worked out in whole
 * paisa, never in floating point. The balance, the payment status and the change actually recorded are all the
 * server's answer; this panel only proposes.
 *
 * Each submit carries one idempotency key, reused if it is retried, so a double tap or a lost response replays the
 * original payment instead of taking the money twice (ADR-010 §7).
 */
export type PaymentPanelProps = {
  orderId: string;
  orderNumber: string;
  currencyCode: string;
  paidAmount: string | null;
  refundedAmount: string | null;
  balanceDue: string | null;
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | null;
  /** This order's own ledger rows, newest first. */
  ledger: TransactionListItem[];
  can: { recordPayment: boolean; refund: boolean; complete: boolean };
};

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
] as const;

export function PaymentPanel({ orderId, orderNumber, currencyCode, paidAmount, refundedAmount, balanceDue, paymentStatus, ledger, can }: PaymentPanelProps) {
  const router = useRouter();
  const toast = useToast();
  const [paying, setPaying] = React.useState(false);
  const [refunding, setRefunding] = React.useState<TransactionListItem | null>(null);
  const [completing, setCompleting] = React.useState(false);

  const money = (amount: string | null) => (amount === null ? "—" : formatMoney(amount, currencyCode));
  const settled = balanceDue !== null && balanceDue === "0.00";
  const refundable = ledger.filter((row) => row.type === "PAYMENT" && row.status === "SUCCESS" && row.refundable !== null && row.refundable !== "0.00");

  async function complete() {
    setCompleting(true);
    const result = await updateOrderStatusAction({ orderId, status: "COMPLETED" } as never);
    setCompleting(false);
    if (result.ok) {
      toast.success(`Order ${orderNumber} completed.`);
      router.refresh();
    } else {
      toast.error(result.error.message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2">
        <Row term="Paid" value={money(paidAmount)} />
        {refundedAmount !== null && refundedAmount !== "0.00" && <Row term="Refunded" value={money(refundedAmount)} />}
        <div className="flex justify-between gap-4 border-t border-border-subtle pt-2">
          <dt className="text-subheading text-fg-primary">Balance due</dt>
          <dd className="text-subheading tabular-nums text-fg-primary">{money(balanceDue)}</dd>
        </div>
      </dl>

      {paymentStatus && (
        <div>
          <StatusBadge domain="payment" status={paymentStatus} />
        </div>
      )}

      {can.recordPayment && !settled && (
        <Button icon={Wallet} onClick={() => setPaying(true)}>
          Record a payment
        </Button>
      )}

      {/* The order is settled but still open: completing it is the next thing anyone would do (BR-ORD-06, Q-007 A). */}
      {settled && can.complete && (
        <Alert tone="success" title="This order is fully paid">
          <Button className="mt-2" icon={BadgeCheck} loading={completing} loadingLabel="Completing…" onClick={complete}>
            Complete the order
          </Button>
        </Alert>
      )}

      {ledger.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {ledger.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-label text-fg-primary">
                  {row.type === "REFUND" ? "Refund" : "Payment"} · {row.method}
                  {row.reference ? ` · ${row.reference}` : ""}
                </span>
                {row.voidReason && <span className="block text-caption text-fg-secondary">Voided: {row.voidReason}</span>}
                {row.reason && <span className="block text-caption text-fg-secondary">{row.reason}</span>}
              </span>
              <span className={`tabular-nums ${row.status === "VOIDED" ? "text-fg-secondary line-through" : "text-fg-primary"}`}>
                {row.type === "REFUND" ? `− ${money(row.amount)}` : money(row.amount)}
              </span>
              {can.refund && row.type === "PAYMENT" && row.status === "SUCCESS" && row.refundable !== null && row.refundable !== "0.00" && (
                <Button variant="ghost" icon={Undo2} onClick={() => setRefunding(row)}>
                  Refund
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-caption text-fg-secondary">
        Every payment and refund is also in{" "}
        <Link href="/restaurant/transactions" className="text-fg-accent hover:underline">
          Transactions
        </Link>
        .
      </p>

      <RecordPaymentDialog
        open={paying}
        onClose={() => setPaying(false)}
        orderId={orderId}
        currencyCode={currencyCode}
        balanceDue={balanceDue ?? "0.00"}
        onDone={(receipt) => {
          setPaying(false);
          // Say what happened to the receipt, honestly: "sent to the printer" is the most the server knows; the print
          // agent's own report is what marks it printed (owner brief 2026-10-06 §15–20).
          if (receipt === "QUEUED") toast.success("Payment recorded. Receipt sent to the printer.");
          else if (receipt === "NO_PRINTER") toast.success("Payment recorded. No receipt printer is set up, so nothing was printed.");
          else if (receipt === "FAILED") toast.error("Payment recorded, but the receipt could not be queued. Print it from the order.");
          else toast.success("Payment recorded.");
          router.refresh();
        }}
      />

      <RefundDialog
        payment={refunding}
        onClose={() => setRefunding(null)}
        currencyCode={currencyCode}
        onDone={() => {
          setRefunding(null);
          toast.success("Refund recorded.");
          router.refresh();
        }}
      />
      {refundable.length === 0 && can.refund && ledger.length > 0 && <span className="sr-only">Nothing on this order can be refunded.</span>}
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-body text-fg-secondary">{term}</dt>
      <dd className="text-body tabular-nums text-fg-primary">{value}</dd>
    </div>
  );
}

function RecordPaymentDialog({
  open,
  onClose,
  orderId,
  currencyCode,
  balanceDue,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  currencyCode: string;
  balanceDue: string;
  onDone: (receipt: ReceiptStatus) => void;
}) {
  const idempotency = useIdempotencyKey();
  const [method, setMethod] = React.useState<string>("CASH");
  const [amount, setAmount] = React.useState<string | null>(balanceDue);
  const [tendered, setTendered] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setMethod("CASH");
      setAmount(balanceDue);
      setTendered(null);
    }
  }, [open, balanceDue]);

  // Cash may be handed over above the balance; the surplus is change, and the server records both (ADR-010 §8).
  const change = method === "CASH" && tendered !== null && amount !== null ? moneyDifference(tendered, amount) : null;

  return (
    <Dialog open={open} onClose={onClose} title="Record a payment" description={`Balance due ${formatMoney(balanceDue, currencyCode)}.`}>
      <Form
        action={(formData: FormData): Promise<ActionResult<unknown>> => {
          const chosen = String(formData.get("method") ?? "CASH");
          const reference = String(formData.get("reference") ?? "").trim();
          const tenderedValue = String(formData.get("amountTendered") ?? "").trim();
          return recordPaymentAction({
            orderId,
            idempotencyKey: idempotency.current(),
            method: chosen as never,
            amount: String(formData.get("amount") ?? "").trim(),
            ...(chosen === "CASH" && tenderedValue !== "" ? { amountTendered: tenderedValue } : {}),
            ...(reference === "" ? {} : { reference }),
          });
        }}
        onSuccess={(data) => {
          idempotency.reset();
          onDone((data as { receipt?: { status: ReceiptStatus } } | null)?.receipt?.status ?? "NOT_REQUESTED");
        }}
      >
        <RadioGroup
          name="method"
          label="How is it being paid?"
          value={method}
          onValueChange={setMethod}
          options={METHODS.map((m) => ({ value: m.value, label: m.label }))}
        />
        <MoneyField name="amount" label="Amount" required currencyCode={currencyCode} defaultValue={balanceDue} onValueChange={setAmount} />

        {method === "CASH" && (
          <>
            <MoneyField name="amountTendered" label="Cash handed over" currencyCode={currencyCode} onValueChange={setTendered} help="Leave empty if it is the exact amount." />
            <p role="status" aria-live="polite" className="min-h-6 text-body">
              {change === null ? null : change.startsWith("-") ? (
                <span className="text-status-danger">That is {formatMoney(change.slice(1), currencyCode)} short of the amount.</span>
              ) : (
                <span className="text-status-success">Change due {formatMoney(change, currencyCode)}</span>
              )}
            </p>
          </>
        )}

        {method !== "CASH" && (
          <TextField
            name="reference"
            label={method === "UPI" ? "UPI reference" : "Card slip reference"}
            required={method === "UPI"}
            autoComplete="off"
            help="4–64 letters, digits or dashes. Never a card number."
          />
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton loadingLabel="Recording…">Record payment</SubmitButton>
        </div>
      </Form>
    </Dialog>
  );
}

function RefundDialog({
  payment,
  onClose,
  currencyCode,
  onDone,
}: {
  payment: TransactionListItem | null;
  onClose: () => void;
  currencyCode: string;
  onDone: () => void;
}) {
  const idempotency = useIdempotencyKey();
  if (payment === null) return null;
  const refundable = payment.refundable ?? "0.00";

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Refund the ${formatMoney(payment.amount, currencyCode)} ${payment.method} payment?`}
      description={`Up to ${formatMoney(refundable, currencyCode)} can still be refunded on this payment.`}
    >
      <Form
        action={(formData: FormData): Promise<ActionResult<unknown>> =>
          createRefundAction({
            paymentTransactionId: payment.id,
            idempotencyKey: idempotency.current(),
            amount: String(formData.get("amount") ?? "").trim(),
            reason: String(formData.get("reason") ?? "").trim(),
          })
        }
        onSuccess={() => {
          idempotency.reset();
          onDone();
        }}
      >
        <MoneyField name="amount" label="Amount to refund" required currencyCode={currencyCode} defaultValue={refundable} />
        <TextArea name="reason" label="Why is it being refunded?" required minLength={5} maxLength={280} showCount help="Recorded in the audit trail and on the ledger row." />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton variant="destructive" loadingLabel="Refunding…">
            Record refund
          </SubmitButton>
        </div>
      </Form>
    </Dialog>
  );
}
