/**
 * Table bill inputs (RASOIOS-ADR-027). Strict objects: a `tenantId`, a total or any other unknown key is 422
 * (SC-TEN-01). The payment fields are the ledger's own (`recordPaymentSchema`), so amount, reference and idempotency
 * rules are identical for an order and for a table. Nothing about the bill's total comes from the client: only the
 * amount being paid, and the bill version the cashier was looking at.
 */
import { z } from "zod";
import { boundedText, e164Field, strictObject } from "./core";
import { recordPaymentSchema } from "./payments";

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const billCustomerSchema = strictObject({
  name: z.preprocess(blankToUndefined, boundedText(120, { min: 2, label: "Customer name" }).optional()),
  phone: z.preprocess(blankToUndefined, e164Field.optional()),
}).transform((value) => (value.name || value.phone ? value : undefined));

export const tableBillIdSchema = strictObject({ tableSessionId: z.string().uuid("Invalid bill id") });
export type TableBillIdInput = z.input<typeof tableBillIdSchema>;

export const payTableBillSchema = recordPaymentSchema
  .omit({ orderId: true, printReceipt: true, receiptCopies: true })
  .extend({
    tableSessionId: z.string().uuid("Invalid bill id"),
    expectedVersion: z.number().int().min(0),
    customer: billCustomerSchema.optional(),
  });
export type PayTableBillInput = z.input<typeof payTableBillSchema>;
export type PayTableBillData = z.output<typeof payTableBillSchema>;

export const closeTableBillSchema = strictObject({
  tableSessionId: z.string().uuid("Invalid bill id"),
  expectedVersion: z.number().int().min(0),
});
export type CloseTableBillInput = z.input<typeof closeTableBillSchema>;

export const tableBillPaymentSchema = strictObject({ paymentId: z.string().uuid("Invalid payment id") });
export type TableBillPaymentInput = z.input<typeof tableBillPaymentSchema>;

/** Order entry's lookup: which open bill a dine-in order for this table would join. */
export const lookupTableBillSchema = strictObject({
  tableLabel: z.string().trim().min(1, "Enter the table").max(20, "Table label must be at most 20 characters"),
});
export type LookupTableBillInput = z.input<typeof lookupTableBillSchema>;
