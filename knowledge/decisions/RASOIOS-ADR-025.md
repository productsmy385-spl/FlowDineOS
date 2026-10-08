---
id: "RASOIOS-ADR-025"
title: "Printing hardening: error catalogue, Test connection, 30-minute KOT retry, one lane per printer, profiles"
status: "APPROVED"
date: "2026-10-08"
refines: ["RASOIOS-ADR-007", "RASOIOS-ADR-015"]
---

# RASOIOS-ADR-025 — Printing hardening

## Context

The printing audit (knowledge/implementation/printing-audit-2026-10-08.md) confirmed the architecture of ADR-004/007 —
cloud queue, authenticated agent pulling over HTTPS, agent printing over LAN/USB — and found the gaps were diagnosis
and resilience. The owner approved the plan on 2026-10-08 and deferred multilingual printing.

## Decision

1. **Architecture unchanged.** The cloud never connects to printers; no third-party print service or virtual printer.
2. **One error catalogue** (`lib/print/error-codes.ts`) shared by server, console and agent; older agents' codes mapped.
   Connection failures are never described as paper problems. `DELIVERY_UNKNOWN` (printer stopped part-way) is not
   retried automatically.
3. **Test connection** (`printer_checks`, RH-AGT-07): the agent opens and closes a TCP connection and reports; no job,
   no paper. Refused up front when the agent is offline or the printer is unassigned/deactivated.
4. **Retry policy per job type:** KOT for up to 30 minutes (5 s → 5 min backoff, cap 30 attempts); receipt 5 minutes;
   test page fails fast. A manual Retry restarts the window. `max_attempts` limit raised to 30 (migration 0010).
5. **One lane per printer:** at most one job per printer per claim and none while one is in flight; the agent prints
   printers in parallel and runs heartbeats in the background. Agent 0.2.0.
6. **Honest states:** PRINTED is shown as "Delivered to printer"; queued-after-failure as "Retrying"; new CANCELLED
   status (only from PENDING/FAILED, owner/manager, audited).
7. **Printer profiles** (`lib/print/profiles.ts`): GENERIC_ESCPOS and TVS_RP3230 (spec-sheet, not yet
   hardware-verified) drive cut, code page and QR/barcode. QR/barcode blocks are sent only to agents ≥ 0.2.0.
8. **Administration without deletion:** archive/restore deactivated printers; close expired pairing attempts
   (REVOKED); duplicate-address warning. All audited.
9. **Multilingual (Telugu) printing deferred.** Extension point: the agent's `TextRenderer` seam and the profile's
   `supportsBitmap`; no redesign needed later.

## Consequences

- Migration 0010 is additive (new enum value, columns, `printer_checks`, constraints).
- Agents before 0.2.0 keep printing; they cannot run Test connection ("agent did not answer") and never get QR blocks.
- Physical output is confirmed only by `printing-hardware-checklist.md`; no status in the app claims paper came out.
- Still open: self-contained Windows installer without a Node.js prerequisite and FlowDineOS branding of the agent's
  install paths/service name (must migrate existing `RasoiOS` installs in place); paper/cover status via `DLE EOT`.
