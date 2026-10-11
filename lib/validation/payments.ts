/**
 * Money-area input schemas (S1-P04-T007; api.md SA-TXN-01, SA-TXN-02, LD-TXN-01; data-model E19).
 *
 * - Every schema is a `strictObject`: `tenantId`, `total`, `paidAmount` or any other unknown key is rejected (422).
 * - Amounts are validated decimal strings (`zodMoney`, ADR-010 §1). The client sends only the amount it is recording;
 *   balances, change and payment status are computed on the server.
 * - Cross-field rules (UPI needs a reference, tendered cash covers the amount, tendered is CASH-only) are ledger rules
 *   enforced by `lib/services/payments.ts`, so these exported schemas stay plain strict objects.
 */
import { PaymentMethod, TransactionStatus, TransactionType } from "@prisma/client";
import { z } from "zod";
import { zodMoney } from "@/lib/money";
import { MIN_PRINT_COPIES, MAX_PRINT_COPIES } from "@/lib/print/types";
import { boundedText, businessDateParam, optionalText, strictObject } from "./core";

/** Card slip / UPI reference: 4–64 letters, digits or dashes (data-model E19). */
export const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,64}$/;

/** 13+ consecutive digits (ignoring dashes) looks like a card number (PAN) and is never stored (ADV-011). */
export function looksLikeCardNumber(value: string): boolean {
  return /\d{13,}/.test(value.replace(/-/g, ""));
}

export const paymentReference = z
  .string()
  .trim()
  .regex(PAYMENT_REFERENCE_PATTERN, "Use 4–64 letters, digits or dashes")
  .refine((value) => !looksLikeCardNumber(value), "Never enter a card number. Use the slip or approval reference.");

/** SA-TXN-01 — record a manual CASH / CARD / UPI payment against an order. */
export const recordPaymentSchema = strictObject({
  orderId: z.string().uuid("Invalid order id"),
  /** Client-generated UUID per submit attempt (ADR-010 §7). A repeated key returns the original payment. */
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
  method: z.nativeEnum(PaymentMethod),
  amount: zodMoney({ positive: true }),
  /** CASH only: the cash handed over. Change is computed on the server. */
  amountTendered: zodMoney({ positive: true }).optional(),
  reference: paymentReference.optional(),
  /** Optional print confirmation: staff can choose whether to print and how many copies for this payment only. */
  printReceipt: z.boolean().optional(),
  receiptCopies: z
    .number()
    .int({ message: "Receipt copies must be an integer" })
    .min(MIN_PRINT_COPIES, { message: `Minimum ${MIN_PRINT_COPIES} copy` })
    .max(MAX_PRINT_COPIES, { message: `Maximum ${MAX_PRINT_COPIES} copies` })
    .optional(),
});

/** SA-TXN-02 — refund (part of) a successful payment. `amount` defaults to the payment's refundable remainder. */
export const createRefundSchema = strictObject({
  paymentTransactionId: z.string().uuid("Invalid payment id"),
  idempotencyKey: z.string().uuid("Invalid idempotency key"),
  amount: zodMoney({ positive: true }).optional(),
  reason: boundedText(280, { min: 5, label: "Reason" }),
});

/** LD-TXN-01 — transaction list filters (date ranges and cursors arrive with S1-P18-T004). */
/** A ledger window is at most a quarter, so one screen can never ask the database for a year of rows. */
export const TRANSACTION_RANGE_MAX_DAYS = 92;

export const listTransactionsSchema = strictObject({
  /** One order's own ledger, for the payment panel on `/restaurant/orders/[orderId]` (S1-P18-T006). */
  orderId: z.string().uuid("Invalid order id").optional(),
  from: businessDateParam.optional(),
  to: businessDateParam.optional(),
  type: z.nativeEnum(TransactionType).optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  q: z.string().trim().max(64).optional(),
  cursor: z.string().uuid("Invalid cursor").optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).superRefine((filters, ctx) => {
  if (!filters.from || !filters.to) return;
  if (filters.from > filters.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "The end date must not be before the start date" });
    return;
  }
  const days = (Date.parse(filters.to + "T00:00:00Z") - Date.parse(filters.from + "T00:00:00Z")) / 86400000 + 1;
  if (days > TRANSACTION_RANGE_MAX_DAYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: `Choose at most ${TRANSACTION_RANGE_MAX_DAYS} days` });
  }
});

export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;
export type RecordPaymentData = z.output<typeof recordPaymentSchema>;
export type CreateRefundInput = z.input<typeof createRefundSchema>;
export type CreateRefundData = z.output<typeof createRefundSchema>;
export type ListTransactionsInput = z.input<typeof listTransactionsSchema>;
export type ListTransactionsFilters = z.output<typeof listTransactionsSchema>;

/** SA-TXN-03 — void a ledger row recorded by mistake, on its own business day, with a reason for the trail. */
export const voidTransactionSchema = strictObject({
  transactionId: z.string().uuid("Invalid transaction id"),
  reason: boundedText(280, { min: 5, label: "Reason" }),
});
export type VoidTransactionInput = z.input<typeof voidTransactionSchema>;
export type VoidTransactionData = z.output<typeof voidTransactionSchema>;

/** SA-TXN-04 — close the business day after counting the drawer. */
export const closeBusinessDaySchema = strictObject({
  businessDate: businessDateParam,
  countedCash: zodMoney(),
  notes: optionalText(500, "Notes"),
});
export type CloseBusinessDayInput = z.input<typeof closeBusinessDaySchema>;
export type CloseBusinessDayData = z.output<typeof closeBusinessDaySchema>;

/** LD-TXN-02 — the preview the closing screen reads. */
export const dayCloseQuerySchema = strictObject({ businessDate: businessDateParam.optional() });
export type DayCloseQueryInput = z.input<typeof dayCloseQuerySchema>;
