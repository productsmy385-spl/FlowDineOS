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

## Agent presence and auto-reconnect lifecycle

Restaurant print agents maintain a persistent identity across PC reboots, service restarts, and network disruptions:

- **Identity persistence:** Once paired, credentials (`credentials.json`) and printed tickets (`journal.json`) are stored securely under `%ProgramData%\FlowDineOS\PrintAgent\` (with fallback migration from legacy `RasoiOS`). Credentials are never cleared on network/server errors.
- **Client reconnection states:** `STARTING` → `CONNECTING` → `ONLINE` → `RECONNECTING` → `STOPPING`. Transient failures (DNS, timeout, HTTP 429, 500, 502, 503) enter `RECONNECTING` with exponential backoff (1 s → 60 s with 20% jitter) and retry indefinitely until restored.
- **Server presence calculation:**
  - `ONLINE`: Last heartbeat seen within 60 seconds (`AGENT_ONLINE_THRESHOLD_MS`).
  - `RECONNECTING`: Last heartbeat between 60 seconds and 120 seconds (`AGENT_OFFLINE_AFTER_MS`).
  - `OFFLINE`: No heartbeat for over 120 seconds.
  - `AUTH_REQUIRED`: Agent record exists but has not completed initial pairing (`PENDING_PAIRING`).
  - `REVOKED`: Administrator explicitly revoked the agent token.
- **Out-of-order heartbeat protection:** Database updates guard `lastSeenAt` to ensure delayed or out-of-order packets cannot overwrite newer timestamps.
- **Process mutual exclusion:** Process lock (`agent.lock`) ensures only a single agent instance polls the server at a time, preventing duplicate poll races.

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

## Virtual Printing & Printer Emulator (Development & Testing)

FlowDineOS includes an isolated virtual printing environment for end-to-end software pipeline validation without physical printer hardware (such as the TVS-E RP 3230).

### Architecture

```
FlowDineOS Cloud ── Secure Print Queue ──HTTPS claim── Virtual Print Agent ──In-Memory/Loopback── VirtualPrinterAdapter ──ESC/POS Decoding── 80mm Thermal Preview
```

The virtual printer does **not** replace the production physical printing architecture. The physical printing path (`Cloud` → `Print Queue` → `Print Agent` → `Restaurant LAN` → `Physical ESC/POS Printer`) remains unmodified and fully supported.

The virtual printer operates as an additional testing adapter implementing the identical `Transport` interface (`connect()`, `disconnect()`, `print()`, `send()`, `testConnection()`, `probe()`, `getStatus()`).

### Production Safety & Fail-Closed Guard

- **Safe By Default:** Virtual printing is disabled in production by default.
- **Environment Flags:**
  - `VIRTUAL_PRINTING_ENABLED="true"`: Enables the virtual printer interface and adapter in non-production environments (`NODE_ENV !== "production"`).
  - `ALLOW_VIRTUAL_PRINTING_IN_PRODUCTION="true"`: Explicit override required if tested in a controlled production environment. Without this explicit variable, production fails closed and throws `Virtual printing is not available`.
- **Tenant Isolation:** Virtual printers and agent tokens are strictly scoped to the authenticated tenant. Tenant A cannot access, control, or preview tickets for Tenant B.

### Virtual Printer Configuration

- **Printer Name:** FlowDineOS Virtual Kitchen Printer
- **Model:** Virtual ESC/POS Printer
- **Profile:** `VIRTUAL_ESCPOS` (80 mm / 48 columns, partial cut, QR, barcode, bitmap support)
- **Address Format:** `virtual:<tenantId>:<station>` (e.g., `virtual:tenant_123:kitchen`)
- **Protocol:** `VIRTUAL`
- **Output:** Decodes genuine ESC/POS commands (`ESC @`, `ESC a`, `GS !`, `GS V`, `ESC d`) into structured lines and renders an authentic 80 mm thermal paper preview.

### Developer CLI & Commands

1. **Start Virtual Agent:**
   ```bash
   npm run agent:virtual
   # Or with explicit pairing code:
   npx tsx print-agent/src/virtual-agent.ts pair <PAIRING_CODE>
   npx tsx print-agent/src/virtual-agent.ts run
   ```
2. **Access Virtual Console UI:**
   Navigate to `/restaurant/printing/virtual` (accessible via "Virtual Console" button on Printing dashboard when enabled).
3. **Simulate Failures:**
   Use the UI or adapter methods to toggle failure modes:
   - `NORMAL`: Printer operates normally.
   - `OFFLINE`: Simulates disconnected hardware (`PRINTER_UNREACHABLE`). Triggers exponential backoff retry.
   - `TIMEOUT`: Simulates hung socket (`CONNECTION_TIMEOUT`).
   - `REFUSED`: Simulates port closed (`CONNECTION_REFUSED`).
   - `SLOW`: Adds a 4-second delay before accepting bytes.
   - `PRINT_FAILED`: Simulates mid-stream error (`DELIVERY_UNKNOWN`).
4. **Run Automated Tests:**
   ```bash
   npx vitest run tests/unit/print-agent/virtual-printer.test.ts
   ```
   Covers all 18 end-to-end scenarios (A through R): pairing, heartbeats, presence status, printer registration, test connection, test ticket, KOT pipeline, thermal preview rendering, retry on failure, recovery on reconnection, duplicate print idempotency, multi-tenant isolation, unauthorized rejection, and multi-printer queue independence.
5. **Disable Virtual Printing:**
   Remove `VIRTUAL_PRINTING_ENABLED` or set `VIRTUAL_PRINTING_ENABLED="false"`. The UI tab disappears and route handlers immediately return 403 Forbidden.

> [!IMPORTANT]
> The virtual printer verifies the software pipeline (UI → Queue → Agent Claim → ESC/POS Encoding → Ack). It does **not** claim physical hardware verification. Final hardware acceptance requires the physical TVS-E RP 3230 printer test.
