import "server-only";
import type { CounterType } from "@prisma/client";
import type { TenantScopedContext } from "@/lib/auth/context-types";
import { ConflictError } from "@/lib/errors";
import { compactIsoDate, toIsoDate } from "@/lib/time/business-date";
import type { Tx } from "./tx";

/**
 * Race-free daily numbering (S1-P12-T003, ADR-010 §6, data-model E26). One atomic upsert on TENANT_COUNTER inside the
 * caller's transaction: concurrent transactions for the same tenant, type and business date serialize on the counter
 * row, so every order/KOT gets a distinct consecutive number, and a rolled-back transaction gives its number back.
 * Separate tenants and separate business dates have independent sequences.
 */
export const COUNTER_LIMITS: Readonly<Record<CounterType, number>> = { ORDER: 9999, KOT: 999, TABLE_BILL: 9999 };

const LIMIT_MESSAGES: Readonly<Record<CounterType, string>> = {
  ORDER: "This restaurant has reached 9,999 orders for the business day.",
  KOT: "This restaurant has reached 999 kitchen tickets for the business day.",
  TABLE_BILL: "This restaurant has reached 9,999 table bills for the business day.",
};

export async function nextNumber(tx: Tx, ctx: TenantScopedContext, type: CounterType, businessDate: Date): Promise<number> {
  // The business date goes in as an ISO date string, never a timestamp, so the session time zone cannot shift it.
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO tenant_counters (tenant_id, counter_type, business_date, last_value, updated_at)
    VALUES (${ctx.tenantId}::uuid, ${type}::counter_type, ${toIsoDate(businessDate)}::date, 1, now())
    ON CONFLICT (tenant_id, counter_type, business_date)
    DO UPDATE SET last_value = tenant_counters.last_value + 1, updated_at = now()
    RETURNING last_value`;
  const value = Number(rows[0].last_value);
  if (value > COUNTER_LIMITS[type]) {
    // Throwing rolls the increment back with the caller's transaction, so the counter stays at the limit.
    throw new ConflictError(LIMIT_MESSAGES[type], "DAILY_NUMBER_LIMIT");
  }
  return value;
}

/** `YYYYMMDD-NNNN`, e.g. `20260915-0042` (BR-ORD-07). */
export function formatOrderNumber(businessDate: Date, value: number): string {
  return `${compactIsoDate(businessDate)}-${String(value).padStart(4, "0")}`;
}

/** `B-YYYYMMDD-NNNN`, e.g. `B-20261013-0003`: a table bill's number, unique per tenant (RASOIOS-ADR-027). */
export function formatBillNumber(businessDate: Date, value: number): string {
  return `B-${compactIsoDate(businessDate)}-${String(value).padStart(4, "0")}`;
}

/** `K-NNN`, e.g. `K-007`, unique per tenant and business date (BR-ORD-07, U-KOT-1). */
export function formatKotNumber(value: number): string {
  return `K-${String(value).padStart(3, "0")}`;
}
