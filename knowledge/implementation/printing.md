---
title: "Printing — architecture and operations reference"
document_type: "REFERENCE"
project: "FlowDineOS (RASOIOS)"
created: "2026-10-08"
related_decisions: ["RASOIOS-ADR-004", "RASOIOS-ADR-007", "RASOIOS-ADR-015", "RASOIOS-ADR-025"]
related_documents: ["printing-audit-2026-10-08.md", "printing-hardware-checklist.md", "../operations/print-agent.md"]
---

# Printing — architecture and operations reference

## Architecture (unchanged by the 2026-10-08 hardening)

```
FlowDineOS cloud ── print_jobs queue (tenant-scoped) ──HTTPS pull── Print Agent (restaurant PC) ──TCP 9100 / USB── printer
```

- The cloud **never** connects to a printer, a private address or the restaurant network. Only the authenticated agent
  does, and it re-validates every address (private IPv4 only, no hostnames).
- No third-party print service, no virtual printer.

## Job states

| Stored (`print_job_status`) | Shown to staff | Meaning |
|---|---|---|
| PENDING, never attempted | Queued | Waiting for its agent |
| PENDING after a failure | Retrying | Next attempt at `next_attempt_at` |
| PROCESSING | Sending to printer | Claimed under a 60 s lease |
| PRINTED | **Delivered to printer** | The agent handed every byte to the printer and the connection closed cleanly. Not proof of paper. |
| FAILED | Failed | Not retryable, or retries ran out (`PRINT_JOB_EXPIRED`) |
| CANCELLED | Cancelled | Withdrawn by owner/manager while queued, retrying or failed |

Transitions: `lib/print/state-machine.ts`. PROCESSING is never cancellable (the agent may be writing to the printer).
PRINTED is written only by the agent's acknowledgement.

## Retry policy (owner decision 2026-10-08)

| Job | Delays | Window | Cap |
|---|---|---|---|
| KOT | 5 s, 10 s, 20 s, 30 s, 1 min, 2 min, then every 5 min | 30 min from creation (or from a manual Retry) | 30 attempts |
| Receipt | 5 s, 10 s, 20 s, 30 s, 1 min | 5 min | 8 |
| Test page | 5 s | 30 s | 2 |

Non-retryable codes fail at once — notably `DELIVERY_UNKNOWN` (the printer stopped part-way: something may be on paper,
so a person decides). The console shows "Printer offline — N tickets waiting, retrying automatically · next try in X".

## Duplicate protection

- **Job creation:** `dedupe_key` is unique per tenant, so a retried API call or browser refresh never creates a second job.
- **Claiming:** each lease has a fresh `claim_token`, and an acknowledgement with a stale token is a 409.
- **Agent journal:** the agent records a job id, fsynced, after the printer accepts it and before acknowledging. A job
  re-claimed after a crash or a lost acknowledgement is acknowledged again, never re-printed.
- **Residual risk:** a crash between the printer accepting the bytes and the journal write can still duplicate a ticket.
  This is documented and rare.

## One lane per printer

A claim returns at most one job per printer — that printer's oldest due job — and none for a printer with a job in
flight. The agent prints different printers in parallel and each printer's tickets in order. Heartbeat probes run in the
background. An unreachable kitchen printer therefore never delays the bar printer.

## Error codes

Catalogue: `lib/print/error-codes.ts`, shared by the server, the console and the agent. Each code has a technical line,
a plain sentence that names the printer, and a retryable flag. Codes from agents before 0.2.0 are mapped, e.g.
`PRINTER_OFFLINE` → `PRINTER_UNREACHABLE`, and `TIMEOUT` → `CONNECTION_TIMEOUT` or `DELIVERY_UNKNOWN`. An unreachable
printer is never described as a paper problem.

## Test connection

1. In Printing → Printers, **Test connection** creates a `printer_checks` row. It is refused at once, with the reason,
   if the printer is deactivated, misconfigured, has no agent, or its agent is offline.
2. The agent picks the check up with its next claim, opens and closes a TCP connection locally, and reports to
   `POST /api/v1/print-agent/checks/{id}`.
3. The printer's health is updated from the result.
4. No print job is created and nothing is printed.

A check that no agent picks up within 45 s shows "agent did not answer"; agents before 0.2.0 cannot run checks.

## Printer profiles

`lib/print/profiles.ts`: `GENERIC_ESCPOS` (conservative) and `TVS_RP3230` (manufacturer specification: 80 mm/48 col,
partial cut, QR, barcode, bitmap; real-time status not used). Each profile selects the code page, the cut type and
whether QR codes or barcodes are printed. `hardwareVerified` becomes true only after `printing-hardware-checklist.md`
passes.

## Multilingual printing (deferred, owner decision 2026-10-08)

Not implemented; non-ASCII script prints as `?`. The seam is in place:

- The agent's `TextRenderer` (`print-agent/src/escpos.ts`) is replaced by a raster renderer, an embedded font turned
  into `GS v 0` image bytes, for profiles with `supportsBitmap`.
- The payload contract, queue and transports do not change.

## Administration

- **Printers:**
  - Test connection, Test print, Edit (including Model), Deactivate.
  - Deactivated printers can be archived or restored.
  - A warning appears when two active printers share one address.
- **Agents:** version, OS, last heartbeat and assigned printers. Expired pairing attempts are hidden behind a toggle and
  can be closed in bulk (status REVOKED, never deleted).
- **Queue:**
  - Filters: Queued, Sending, Retrying, Delivered, Failed, Cancelled.
  - Retry (failed jobs), Cancel (owner/manager).
  - Clear history (delivered, failed and cancelled jobs only).
- **Audit actions:** `printer.connection_test_requested`, `printer.archived`, `printer.restored`,
  `print_job.cancelled`, `print_agent.pairings_expired`, plus the existing printer, agent and job actions.

## Still open

- Self-contained Windows installer: built (print-agent-windows.md) — `FlowDineOS-Print-Agent-Setup.exe`, Windows
  service, no Node.js; verified by install/upgrade/uninstall in CI. Pending: hand test on a clean PC, code signing, and
  pointing the console's download at the released installer.
- Paper-out and cover-open detection (`DLE EOT`) — needs verification on the RP 3230 first.
- Hardware acceptance of the RP 3230 (blocked on the network issue in the checklist).
