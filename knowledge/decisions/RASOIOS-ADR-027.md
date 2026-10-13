---
id: "RASOIOS-ADR-027"
title: "Table bills: one consolidated bill per dine-in table session, table payments on the per-order ledger, KOT print choice"
status: "PROPOSED"
date: "2026-10-13"
refines: ["RASOIOS-ADR-010", "RASOIOS-ADR-007", "RASOIOS-ADR-026"]
---

# RASOIOS-ADR-027 — Table bills and the KOT print choice

## Context

Owner brief 2026-10-13: a dine-in party that orders several times at one table got one bill and one receipt per
order. The owner asked for one bill per table visit (each order still its own KOT), one payment and one receipt for
the table, and a choice on "Send to KOT" between printing and screen-only.

Before this change orders referenced a table only by free text (`orders.table_label`), the ledger was per order
(`transactions.order_id`), and refunds, day close, reports and backups all read it per order. No Voice KOT and no
website ordering existed (the `PUBLIC_WEB` channel is unused), and there were no service charges.

## Decision

1. **`table_sessions`** (migration 0014): a bill per dine-in party at one table, `OPEN` → `CLOSED`, with a bill number
   from the tenant counter (`TABLE_BILL`, `B-YYYYMMDD-NNNN`) and a `version`. A partial unique index allows one OPEN
   bill per `(tenant, normalised table label)`. `orders.table_session_id` links orders (composite tenant FK).
2. **Joining is part of placing the order.** A dine-in order with a table joins its table's OPEN bill or opens one, in
   the order's own transaction under the session row lock. Order entry shows the bill first and sends the id it saw
   (`expectedTableSessionId`, or null for "new bill"); a mismatch is 409 (`TABLE_HAS_OPEN_BILL`, `TABLE_BILL_CLOSED`,
   `TABLE_BILL_CHANGED`). Takeaway, delivery and orders without a table get no bill. Nothing is ever joined by
   customer name or phone. Historical orders keep `table_session_id = NULL` — no backfill, nothing merged.
3. **The bill is a sum of snapshots.** `lib/billing/table-bill.ts` adds the orders' stored subtotal, tax, discount and
   total; lines keep the unit price they were sold at (later menu changes never move a bill). CANCELLED and REFUNDED
   orders are listed but not billed. Identical items at the identical price and tax rate are grouped for display with
   their source orders kept.
4. **One table payment, per-order ledger rows.** `recordTableBillPayment` (`lib/services/payments.ts`) locks the
   session and all its orders, refuses a stale bill version (`BILL_CHANGED`), applies the per-order ledger's amount
   rules (cash surplus is change), and writes one `TRANSACTION` per order it pays, oldest first, each order's totals
   and payment status recomputed as for a per-order payment. `table_session_payments` holds the payment as a whole —
   idempotency key, tendered, change; `transactions.table_session_payment_id` links its rows. Refunds, voids, day
   close and reports are unchanged. The bill closes when its balance reaches zero; a bill owing nothing can also be
   closed by hand at the version seen.
5. **Per-order payment is refused for an order on an OPEN table bill** (`TABLE_BILL`), in the order page and in the
   simplified workflow's board settle, so a table is never paid twice over or printed per order.
6. **After a settling payment:** READY orders complete through the state machine (others stay open); one consolidated
   receipt is queued, `RECEIPT:SESSION:{paymentId}[:c{n}]`, with the printer's own copies and labels and the same
   v1 document (an extra text line lists the order numbers). Retry requeues the same FAILED jobs or queues under the
   same keys. A part payment prints nothing, as for a single order.
7. **KOT print choice.** "Send to KOT + Print" (default, unchanged) or "Send to KOT only": the tickets are created as
   usual, `kot_tickets.print_requested = false`, and no print job is created — so nothing can retry it. The board and
   kitchen screen read `NOT_REQUESTED`; a manual reprint remains possible.
8. **Backups** export, restore and date-range-delete `table_sessions` and `table_session_payments` with their orders and
   payments.

## Consequences

- Migration 0014 is additive: two tables, two nullable link columns, one defaulted KOT column, one enum value.
- Restoring a backup whose OPEN bill collides with a currently OPEN bill for the same table is refused as a whole.
- Table labels are free text, normalised by case and spacing only ("T1" and "T 1" are different tables).
- Not built (did not exist to preserve): Voice KOT, website orders, service charges.
