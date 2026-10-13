---
id: "RASOIOS-ADR-026"
title: "Simplified order workflow: per-restaurant switch, server-side 10-minute auto-READY, Record Payment on the board"
status: "PROPOSED"
date: "2026-10-13"
refines: ["RASOIOS-ADR-009", "RASOIOS-ADR-010", "RASOIOS-ADR-023"]
---

# RASOIOS-ADR-026 — Simplified order workflow

## Context

Owner brief 2026-10-13: restaurant staff spend too many clicks on kitchen status updates and on getting from "food is
out" to "paid, completed, receipt printed". The owner asked for an optional workflow that cuts this to a few clicks
without changing the existing one for restaurants that keep it off.

## Decision

1. **A per-restaurant switch, off by default.** `restaurants.simplified_workflow` (migration 0013), saved with the
   operational settings (`restaurant:settings:update`, i.e. owner/administrator and manager), audited as
   `restaurant.settings_updated`. It is a workflow switch, not a feature package or price (ADR-002/023 unchanged).
2. **10 minutes after acceptance, the order becomes READY — on the server.** `lib/services/simplified-workflow.ts`
   `runAutoReadySweep`, started once per server process from `instrumentation.ts` and run every 60 s
   (`lib/jobs/auto-ready-scheduler.ts`). It never depends on an open browser and never runs per request. The timer
   starts at `orders.accepted_at`.
   - Eligible: ACCEPTED or PREPARING orders of ACTIVE tenants with the switch on. PREPARING is included so an order a
     chef started but never marked Ready still advances; it is a forward move, never backwards.
   - The latest round's open KOTs become READY with the order, so the kitchen board agrees with the order board.
   - Never touches READY, COMPLETED, CANCELLED or REFUNDED orders, and never records payment or completes.
   - Concurrency: discovery query, then per order `SELECT … FOR UPDATE SKIP LOCKED` with the switch re-checked under the
     lock, then a version compare-and-set. Any number of replicas may sweep; each order advances once. Audited with
     actor SYSTEM, trigger `simplified_workflow_timer`.
   - A Railway cron service was not chosen: it would add infrastructure and a shared secret for something the
     long-running `next start` process can do. If the app ever runs serverless, move the sweep to a cron trigger.
     `ORDER_AUTO_READY_DISABLED=1` stops it in a process.
3. **Record Payment on the Orders board** (switch on, `payment:record` + `transaction:read`). One dialog: optional
   customer name/phone (only when the order has no customer — an existing one is shown and never replaced or edited),
   then the **existing** ledger service `recordPayment` (same idempotency key, amount, cash-change and day-close rules).
   If the payment settles the bill and the order is READY, it is completed through the existing state machine
   (READY → COMPLETED requires PAID, unchanged). Receipts are the existing payment-keyed jobs
   (`RECEIPT:PAYMENT:{transactionId}[:c{n}]`), using each printer's own copy count and copy labels.
4. **Honest receipt status.** The dialog polls the jobs and shows the queue's states (Queued, Sending, Retrying,
   Delivered, Failed). Retry requeues the same FAILED jobs (`retryPrintJob`) or, if none were queued, queues the
   payment's receipt under its own dedupe keys — never a second payment and never a duplicate copy.
5. **Off means off.** With the switch off the sweep skips the restaurant and the board's settle actions refuse with
   409 `WORKFLOW_DISABLED`; the order page's payment panel is unchanged in both modes.

## Consequences

- Migration 0013 is additive (one boolean column, default false).
- An order shown READY by the timer is not proof the food is ready; the setting's help text says so.
- The timer's delay is fixed at 10 minutes (`AUTO_READY_AFTER_MINUTES`); a per-restaurant value would need a column.
- No agent or payload change: receipt jobs are rendered by the same producer, so installed agents are unaffected.
