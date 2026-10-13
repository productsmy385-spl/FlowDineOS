/**
 * Simplified order workflow inputs (owner brief 2026-10-13). Strict objects: a `tenantId` or any other unknown key is
 * 422 (SC-TEN-01). The payment fields are the ledger's own (`recordPaymentSchema`), so the amount, reference and
 * idempotency rules cannot drift from the order page's payment dialog.
 */
import { z } from "zod";
import { boundedText, e164Field, strictObject } from "./core";
import { recordPaymentSchema } from "./payments";

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

/** Optional customer details for an order that has none. Both empty = no customer. */
const settleCustomerSchema = strictObject({
  name: z.preprocess(blankToUndefined, boundedText(120, { min: 2, label: "Customer name" }).optional()),
  phone: z.preprocess(blankToUndefined, e164Field.optional()),
}).transform((value) => (value.name || value.phone ? value : undefined));

export const settleOrderSchema = recordPaymentSchema
  .omit({ printReceipt: true, receiptCopies: true })
  .extend({ customer: settleCustomerSchema.optional() });
export type SettleOrderInput = z.input<typeof settleOrderSchema>;
export type SettleOrderData = z.output<typeof settleOrderSchema>;

export const settlementQuerySchema = strictObject({ orderId: z.string().uuid("Invalid order id") });
export type SettlementQueryInput = z.input<typeof settlementQuerySchema>;

export const paymentReceiptsSchema = strictObject({
  orderId: z.string().uuid("Invalid order id"),
  transactionId: z.string().uuid("Invalid payment id"),
});
export type PaymentReceiptsInput = z.input<typeof paymentReceiptsSchema>;
