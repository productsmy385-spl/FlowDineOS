"use client";

import { useEffect, useState, useTransition } from "react";
import { PaymentMethod } from "@prisma/client";
import { createRefundAction, listBillableOrdersAction, listTransactionsAction, recordPaymentAction } from "../transactions/actions";
import type { ActionError } from "@/lib/http/action";
import type { BillableOrderDto } from "@/lib/data/payments";
import type { TransactionListItem } from "@/lib/data/transactions";
import { formatMoney } from "@/lib/ui/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  CreditCard,
  DollarSign,
  Minus,
  Plus,
  QrCode,
  Receipt,
  Printer,
  RefreshCw,
} from "lucide-react";
import { printReceiptAction } from "../printing/actions";
import { MIN_PRINT_COPIES, MAX_PRINT_COPIES } from "@/lib/print/types";

type OrderData = BillableOrderDto;
type TransactionData = TransactionListItem;

/** The action's message plus any field messages (e.g. "Enter the UPI reference"). */
function describeError(error: ActionError): string {
  const fields = error.fieldErrors ? Object.values(error.fieldErrors).flat() : [];
  return fields.length > 0 ? `${error.message} ${fields.join(" ")}` : error.message;
}

export default function StaffBillingPage() {
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [transactions, setTransactions] = useState<TransactionData[]>([]);
  const [activeTab, setActiveTab] = useState<"UNPAID" | "TRANSACTIONS">("UNPAID");

  const [selectedOrder, setSelectedOrder] = useState<OrderData | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [amountTendered, setAmountTendered] = useState("");
  const [txRef, setTxRef] = useState("");
  /** One UUID per settlement attempt: a double submit or a retry after a lost response replays, never double-charges. */
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [printReceipt, setPrintReceipt] = useState(true);
  const [receiptCopies, setReceiptCopies] = useState(2);
  const [retryPrintOrder, setRetryPrintOrder] = useState<{ orderId: string; copies: number } | null>(null);
  const [isRetryingPrint, setIsRetryingPrint] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();

  function fetchData() {
    setIsLoading(true);
    startTransition(async () => {
      try {
        const [ordersRes, txRes] = await Promise.all([
          listBillableOrdersAction(),
          listTransactionsAction(),
        ]);

        if (ordersRes.ok) {
          setOrders(ordersRes.data);
        } else {
          setErrorMsg(describeError(ordersRes.error));
        }
        if (txRes.ok) {
          setTransactions(txRes.data.items);
        } else {
          setErrorMsg(describeError(txRes.error));
        }
      } catch (err: any) {
        setErrorMsg(err.message || "Failed to load billing data");
      } finally {
        setIsLoading(false);
      }
    });
  }

  useEffect(() => {
    fetchData();
  }, []);

  const orderTotal = selectedOrder
    ? parseFloat(selectedOrder.balance)
    : 0;
  // Server amounts are exact decimal strings; the cash-change preview may not be (typed input), so fall back to raw text.
  const money = (amount: string, currencyCode = selectedOrder?.currencyCode ?? "INR") => {
    try {
      return formatMoney(amount, currencyCode);
    } catch {
      return amount;
    }
  };
  const tenderedNum = parseFloat(amountTendered) || 0;
  const changeDue = Math.max(0, tenderedNum - orderTotal);

  async function handleSettlePayment(e?: React.FormEvent, overridePrint?: boolean) {
    if (e) e.preventDefault();
    if (!selectedOrder) return;

    if (paymentMethod === PaymentMethod.CASH && tenderedNum < orderTotal) {
      setErrorMsg(`Amount tendered (${money(tenderedNum.toFixed(2))}) is less than the amount due (${money(selectedOrder.balance)})`);
      return;
    }

    const shouldPrint = overridePrint !== undefined ? overridePrint : printReceipt;

    setIsProcessing(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await recordPaymentAction({
        orderId: selectedOrder.id,
        idempotencyKey,
        method: paymentMethod,
        amount: selectedOrder.balance,
        reference: txRef.trim() || undefined,
        amountTendered: paymentMethod === PaymentMethod.CASH ? amountTendered.trim() : undefined,
        printReceipt: shouldPrint,
        receiptCopies: shouldPrint ? receiptCopies : undefined,
      });

      if (res.ok) {
        if (res.data.receipt?.status === "FAILED") {
          setErrorMsg("Payment recorded successfully, but receipt printing failed.");
          setRetryPrintOrder({ orderId: selectedOrder.id, copies: receiptCopies });
        } else if (res.data.receipt?.status === "QUEUED") {
          setSuccessMsg(`Payment of ${money(res.data.amount)} recorded. Receipt sent to the printer.`);
          setRetryPrintOrder(null);
        } else {
          setSuccessMsg(`Payment of ${money(res.data.amount)} recorded successfully for ${selectedOrder.orderNumber}!`);
          setRetryPrintOrder(null);
        }

        // Open receipt pop-up
        window.open(`/restaurant/billing/receipt/${selectedOrder.id}`, "_blank");
        setSelectedOrder(null);
        setAmountTendered("");
        setTxRef("");
        setIdempotencyKey("");
        fetchData();
      } else {
        setErrorMsg(describeError(res.error));
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to process payment");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRetryPrintReceipt() {
    if (!retryPrintOrder) return;
    setIsRetryingPrint(true);
    try {
      const res = await printReceiptAction({ orderId: retryPrintOrder.orderId, copies: retryPrintOrder.copies });
      if (res.ok) {
        setSuccessMsg("Receipt sent to printer.");
        setRetryPrintOrder(null);
        setErrorMsg(null);
      } else {
        setErrorMsg(res.error.message || "Receipt printing failed. Please check printer connection.");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to retry receipt printing");
    } finally {
      setIsRetryingPrint(false);
    }
  }

  async function handleRefundTransaction(txId: string) {
    // The prompt doubles as the confirmation; a refund always records why (refund.created audit).
    const reason = window.prompt("Reason for refunding this transaction (5–280 characters):");
    if (reason === null) return;
    try {
      setErrorMsg(null);
      const res = await createRefundAction({ paymentTransactionId: txId, idempotencyKey: crypto.randomUUID(), reason });
      if (res.ok) {
        setSuccessMsg("Transaction refunded successfully.");
        fetchData();
      } else {
        setErrorMsg(describeError(res.error));
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to refund transaction");
    }
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border-subtle pb-5">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-status-success/10 text-status-success rounded-2xl border border-status-success/20">
            <Receipt className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold font-display text-fg-primary">
              Billing & Cashier Terminal
            </h1>
            <p className="text-xs text-fg-secondary">
              Process guest settlements, record payments, and print tax bills
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={fetchData}
            disabled={isLoading || isPending}
            variant="secondary"
            size="sm"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 bg-status-danger/40 text-status-danger border border-status-danger/30 rounded-xl text-sm flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-status-danger hover:text-fg-primary">
            ✕
          </button>
        </div>
      )}

      {successMsg && (
        <div className="p-4 bg-status-success/40 text-status-success border border-status-success/30 rounded-xl text-sm flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="text-status-success hover:text-fg-primary">
            ✕
          </button>
        </div>
      )}

      {retryPrintOrder && (
        <div className="p-4 bg-status-warning/20 border border-status-warning/40 rounded-xl text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-fg-primary block">Payment recorded successfully, but receipt printing failed.</span>
            <span className="text-xs text-fg-secondary">The payment is safely recorded. You can retry sending the receipt to the printer without charging again.</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRetryPrintReceipt}
            disabled={isRetryingPrint}
          >
            <Printer className="w-4 h-4 mr-2" />
            {isRetryingPrint ? "Sending..." : "Retry printing receipt"}
          </Button>
        </div>
      )}

      {/* Mode Tabs */}
      <div className="flex items-center gap-4 border-b border-border-subtle pb-2">
        <button
          onClick={() => setActiveTab("UNPAID")}
          className={`pb-2 text-sm font-semibold transition-all border-b-2 ${
            activeTab === "UNPAID"
              ? "border-action-primary text-fg-accent"
              : "border-transparent text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Orders Awaiting Settlement ({orders.length})
        </button>
        <button
          onClick={() => setActiveTab("TRANSACTIONS")}
          className={`pb-2 text-sm font-semibold transition-all border-b-2 ${
            activeTab === "TRANSACTIONS"
              ? "border-action-primary text-fg-accent"
              : "border-transparent text-fg-secondary hover:text-fg-primary"
          }`}
        >
          Settled Transactions Log ({transactions.length})
        </button>
      </div>

      {activeTab === "UNPAID" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {orders.map((order) => {
            return (
              <Card
                key={order.id}
                className="p-5 space-y-4 bg-card border-border-subtle flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                    <div>
                      <div className="tabular-nums text-base font-bold text-fg-accent">
                        {order.orderNumber}
                      </div>
                      <div className="text-xs text-fg-secondary">
                        {order.tableLabel ? `Table ${order.tableLabel}` : order.orderType}
                      </div>
                    </div>
                    <Badge variant="outline">{order.status}</Badge>
                  </div>

                  {/* Customer / Items preview */}
                  <div className="text-xs space-y-1 text-fg-secondary">
                    {order.customerName && (
                      <div className="text-fg-primary font-medium">
                        Patron: {order.customerName}
                      </div>
                    )}
                    <div className="pt-1">
                      {order.items.map((i) => (
                        <div key={i.id} className="flex justify-between text-caption">
                          <span>{i.quantity}x {i.name}</span>
                          <span className="tabular-nums">{money(i.lineTotal, order.currencyCode)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-border-subtle flex items-center justify-between">
                  <div>
                    <div className="text-caption text-fg-secondary">Amount Due</div>
                    <div className="tabular-nums text-xl font-extrabold text-status-success">
                      {money(order.balance, order.currencyCode)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <a
                      href={`/restaurant/billing/receipt/${order.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-raised hover:bg-raised text-fg-secondary hover:text-fg-primary rounded-xl border border-border-subtle"
                      title="Preview Tax Receipt"
                    >
                      <Printer className="w-4 h-4" />
                    </a>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setSelectedOrder(order);
                        setAmountTendered(order.balance);
                        setIdempotencyKey(crypto.randomUUID());
                        setPrintReceipt(true);
                        setReceiptCopies(2);
                      }}
                    >
                      Pay {money(order.balance, order.currencyCode)}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        /* Transactions Table */
        <div className="bg-card border border-border-subtle rounded-xl overflow-hidden shadow-e2">
          <table className="w-full text-left text-xs">
            <thead className="bg-canvas text-fg-secondary uppercase tracking-wider font-semibold border-b border-border-subtle">
              <tr>
                <th className="px-5 py-3.5">Date & Time</th>
                <th className="px-5 py-3.5">Order #</th>
                <th className="px-5 py-3.5">Payment Method</th>
                <th className="px-5 py-3.5">Reference</th>
                <th className="px-5 py-3.5 text-right">Amount</th>
                <th className="px-5 py-3.5 text-center">Status</th>
                <th className="px-5 py-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle text-fg-primary">
              {transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-raised transition-colors">
                  <td className="px-5 py-4 tabular-nums text-fg-secondary">
                    {new Date(tx.createdAt).toLocaleString()}
                  </td>
                  <td className="px-5 py-4 tabular-nums font-bold text-fg-accent">
                    {tx.orderNumber}
                  </td>
                  <td className="px-5 py-4 uppercase font-bold tracking-wider text-xs">
                    <span className="px-2 py-0.5 bg-raised rounded border border-border-subtle">
                      {tx.type === "REFUND" ? `${tx.method} REFUND` : tx.method}
                    </span>
                  </td>
                  <td className="px-5 py-4 tabular-nums text-fg-secondary">
                    {tx.reference || "—"}
                  </td>
                  <td className="px-5 py-4 text-right tabular-nums font-bold text-status-success text-sm">
                    {tx.type === "REFUND" ? "-" : ""}{money(tx.amount, tx.currencyCode)}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <Badge variant={tx.status === "SUCCESS" ? "success" : "destructive"}>
                      {tx.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-right">
                    {tx.type === "PAYMENT" && tx.status === "SUCCESS" && tx.refundable !== "0.00" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleRefundTransaction(tx.id)}
                      >
                        Refund
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Payment Settlement Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-canvas text-fg-primary border border-border-subtle rounded-2xl max-w-lg w-full p-6 space-y-6 shadow-e3">
            <div className="flex items-center justify-between border-b border-border-subtle pb-4">
              <div>
                <h2 className="text-xl font-bold font-display text-fg-primary">
                  Settle Payment — {selectedOrder.orderNumber}
                </h2>
                <p className="text-xs text-fg-secondary">
                  Select payment channel and verify monetary total
                </p>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="text-fg-secondary hover:text-fg-primary text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSettlePayment} className="space-y-5">
              {/* Payment Method Selector */}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase text-fg-secondary tracking-wider">
                  Payment Method
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { method: "CASH", icon: DollarSign, label: "Cash" },
                    { method: "CARD", icon: CreditCard, label: "Card" },
                    { method: "UPI", icon: QrCode, label: "UPI" },
                  ].map(({ method, icon: Icon, label }) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setPaymentMethod(method as PaymentMethod)}
                      className={`py-3 flex flex-col items-center gap-1 rounded-xl border text-xs font-semibold transition-all ${
                        paymentMethod === method
                          ? "bg-status-success/60 text-status-success border-status-success"
                          : "bg-card text-fg-secondary border-border-subtle hover:border-border-strong"
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Amount Breakdown */}
              <div className="p-4 bg-card border border-border-subtle rounded-xl space-y-2">
                <div className="flex justify-between text-xs text-fg-secondary">
                  <span>Amount Due</span>
                  <span className="tabular-nums text-fg-primary font-bold text-sm">{money(selectedOrder.balance)}</span>
                </div>

                {paymentMethod === "CASH" && (
                  <>
                    <div className="flex justify-between items-center pt-2 border-t border-border-subtle">
                      <label className="text-xs text-fg-secondary">Amount Tendered</label>
                      <Input
                        type="number"
                        step="0.01"
                        className="w-32 text-right tabular-nums text-sm"
                        value={amountTendered}
                        onChange={(e) => setAmountTendered(e.target.value)}
                      />
                    </div>
                    <div className="flex justify-between text-xs pt-1">
                      <span className="text-fg-secondary">Change Due</span>
                      <span className="tabular-nums font-bold text-status-success text-sm">
                        {money(changeDue.toFixed(2))}
                      </span>
                    </div>
                  </>
                )}

                {(paymentMethod === "CARD" || paymentMethod === "UPI") && (
                  <div className="pt-2 border-t border-border-subtle">
                    <label className="text-xs text-fg-secondary">Transaction Reference / Approval Code</label>
                    <Input
                      placeholder="e.g. TXN987654321"
                      className="mt-1 text-xs"
                      value={txRef}
                      onChange={(e) => setTxRef(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* Receipt Printing Preferences */}
              <div className="p-4 bg-card border border-border-subtle rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-fg-primary block">Receipt Printing</span>
                    <span className="text-caption text-fg-secondary block">
                      Print receipt after recording payment
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={printReceipt}
                      onClick={() => setPrintReceipt(!printReceipt)}
                      className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors ${
                        printReceipt ? "bg-action-primary" : "bg-border-strong"
                      }`}
                    >
                      <span
                        className={`inline-block size-3.5 transform rounded-full bg-canvas transition-transform ${
                          printReceipt ? "translate-x-5" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span className="text-xs font-semibold text-fg-primary">
                      {printReceipt ? "Yes" : "No"}
                    </span>
                  </div>
                </div>

                {printReceipt && (
                  <div className="space-y-3 pt-2 border-t border-border-subtle">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-fg-secondary">Number of receipt copies</label>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={receiptCopies <= MIN_PRINT_COPIES}
                          onClick={() => setReceiptCopies((c) => Math.max(MIN_PRINT_COPIES, c - 1))}
                          aria-label="Decrease copies"
                          className="h-7 w-7 p-0"
                        >
                          <Minus className="w-3 h-3" />
                        </Button>
                        <span className="min-w-6 text-center text-xs tabular-nums font-bold text-fg-primary">
                          {receiptCopies}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={receiptCopies >= MAX_PRINT_COPIES}
                          onClick={() => setReceiptCopies((c) => Math.min(MAX_PRINT_COPIES, c + 1))}
                          aria-label="Increase copies"
                          className="h-7 w-7 p-0"
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-lg bg-raised p-2 text-xs space-y-1">
                      <div className="font-semibold text-fg-primary text-caption">Receipt Copies</div>
                      {receiptCopies === 1 ? (
                        <div className="text-fg-secondary">Standard receipt: 1</div>
                      ) : receiptCopies === 2 ? (
                        <div className="flex justify-between text-fg-secondary">
                          <span>Customer copy: 1</span>
                          <span>Restaurant copy: 1</span>
                          <span className="font-semibold text-fg-primary">Total: 2</span>
                        </div>
                      ) : (
                        <div className="space-y-0.5 text-fg-secondary">
                          <div className="flex justify-between">
                            <span>Customer copy: 1</span>
                            <span>Restaurant copy: 1</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Additional copies: {receiptCopies - 2}</span>
                            <span className="font-semibold text-fg-primary">Total: {receiptCopies}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setSelectedOrder(null)}
                >
                  Cancel
                </Button>
                {printReceipt && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isProcessing}
                    onClick={() => handleSettlePayment(undefined, false)}
                  >
                    Record without printing
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={isProcessing}
                  variant="primary"
                  className="bg-status-success hover:bg-status-success py-2.5 px-6 font-bold"
                >
                  {isProcessing
                    ? "Processing..."
                    : printReceipt
                    ? `Confirm payment and print — ${money(selectedOrder.balance)}`
                    : `Confirm payment — ${money(selectedOrder.balance)}`}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
