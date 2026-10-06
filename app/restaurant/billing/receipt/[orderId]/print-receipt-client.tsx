"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReceiptDto } from "@/lib/data/receipts";
import { formatInZone, formatMoney } from "@/lib/ui/format";

/**
 * Receipt layout. Every amount is a server-computed decimal string (lib/data/receipts.ts) formatted with the order's
 * currency; nothing is recomputed here, so the print reconciles to the order and the ledger (TC-TXN-008).
 */
export function PrintReceiptClient({ data }: { data: ReceiptDto }) {
  const money = (amount: string) => formatMoney(amount, data.currencyCode);
  const payments = data.ledger.filter((tx) => tx.type === "PAYMENT");
  const refunds = data.ledger.filter((tx) => tx.type === "REFUND");

  return (
    <main data-theme="light" className="min-h-screen bg-canvas text-fg-primary p-4 flex flex-col items-center justify-start print:bg-white print:p-0">
      {/* Print Controls (Hidden when printing) */}
      <div className="w-full max-w-sm mb-6 flex items-center justify-between print:hidden text-fg-primary">
        <Button
          onClick={() => window.print()}
          variant="primary"
          className="bg-action-primary hover:bg-action-primary font-bold w-full"
        >
          <Printer className="w-4 h-4 mr-2" /> Print Tax Invoice / Receipt
        </Button>
      </div>

      {/* Thermal Thermal Receipt Layout (80mm / 3inch width format) */}
      <div className="w-full max-w-[380px] bg-card text-fg-primary p-6 tabular-nums text-xs shadow-e2 rounded-xl print:shadow-none print:w-full print:max-w-none print:p-2 border border-border-subtle">
        {/* Restaurant Header */}
        <div className="text-center space-y-1 pb-4 border-b border-black">
          <h1 className="text-lg font-bold font-sans uppercase tracking-wider">
            {data.restaurant.name}
          </h1>
          {data.restaurant.address && (
            <p className="text-caption text-fg-secondary leading-tight">{data.restaurant.address}</p>
          )}
          {data.restaurant.contactPhone && (
            <p className="text-caption text-fg-secondary">Ph: {data.restaurant.contactPhone}</p>
          )}
          <p className="text-caption font-bold mt-2 uppercase border border-black inline-block px-2 py-0.5">
            TAX INVOICE / RECEIPT
          </p>
        </div>

        {/* Order Details */}
        <div className="py-3 border-b border-black text-caption space-y-1">
          <div className="flex justify-between">
            <span className="font-bold">Order #:</span>
            <span>{data.orderNumber}</span>
          </div>
          <div className="flex justify-between">
            <span>Date/Time:</span>
            <span>{formatInZone(data.createdAt, data.timezone, "datetime")}</span>
          </div>
          <div className="flex justify-between">
            <span>Order Type:</span>
            <span className="font-bold">{data.orderType}</span>
          </div>
          {data.tableLabel && (
            <div className="flex justify-between font-bold">
              <span>Table #:</span>
              <span>{data.tableLabel}</span>
            </div>
          )}
          {data.customerName && (
            <div className="flex justify-between pt-1 text-caption">
              <span>Customer:</span>
              <span>{data.customerName}</span>
            </div>
          )}
        </div>

        {/* Itemized Table */}
        <div className="py-3 border-b border-black space-y-2">
          <div className="flex justify-between font-bold text-caption uppercase tracking-wider border-b border-border-subtle pb-1">
            <span>Item</span>
            <span>Qty x Price</span>
            <span>Total</span>
          </div>

          {data.items.map((item) => (
            <div key={item.id} className="space-y-0.5 text-caption">
              <div className="font-bold">{item.name}</div>
              <div className="flex justify-between text-caption text-fg-secondary">
                <span>
                  {item.quantity} x {money(item.unitPrice)}
                </span>
                <span className="font-bold text-fg-primary">{money(item.lineSubtotal)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Financial Summary */}
        <div className="py-3 border-b border-black space-y-1 text-caption">
          <div className="flex justify-between text-fg-secondary">
            <span>Subtotal:</span>
            <span>{money(data.totals.subtotal)}</span>
          </div>
          <div className="flex justify-between text-fg-secondary">
            <span>Tax Amount:</span>
            <span>{money(data.totals.tax)}</span>
          </div>
          <div className="flex justify-between font-extrabold text-sm pt-1 border-t border-dashed border-border-subtle">
            <span>GRAND TOTAL:</span>
            <span>{money(data.totals.total)}</span>
          </div>
        </div>

        {/* Payment Details */}
        <div className="py-3 border-b border-black text-caption space-y-1">
          <div className="font-bold uppercase tracking-wider text-fg-secondary">
            Payment Status & Method
          </div>
          {payments.length === 0 ? (
            <div className="text-status-danger font-bold uppercase">UNPAID / PENDING</div>
          ) : (
            payments.map((tx) => (
              <div key={tx.id} className="flex justify-between">
                <span>{tx.method} Payment:</span>
                <span className="font-bold">{money(tx.amount)}</span>
              </div>
            ))
          )}
          {refunds.map((tx) => (
            <div key={tx.id} className="flex justify-between">
              <span>{tx.method} Refund:</span>
              <span className="font-bold">-{money(tx.amount)}</span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="text-center pt-4 text-caption text-fg-secondary space-y-1">
          <p className="font-bold text-fg-primary">Thank you for dining with us!</p>
          <p>Please come again.</p>
          <p className="text-fg-secondary pt-2">Powered by FlowDineOS</p>
        </div>
      </div>
    </main>
  );
}
