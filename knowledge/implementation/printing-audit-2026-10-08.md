---
title: "Printing system — audit and upgrade plan"
document_type: "AUDIT"
project: "FlowDineOS (RASOIOS)"
created: "2026-10-08"
status: "PHASE 1 + 2 COMPLETE — awaiting owner review before any code change"
related_decisions: ["RASOIOS-ADR-004", "RASOIOS-ADR-007", "RASOIOS-ADR-015"]
related_documents: ["../operations/print-agent.md", "slice-01/architecture.md", "slice-01/security.md"]
---

# Printing system — audit and upgrade plan (2026-10-08)

Scope: the owner brief "FlowDineOS — production-grade physical printing system upgrade". Phase 1 (audit) and Phase 2
(plan) only. **No code was changed for this document.** Evidence is tagged `[fact]` (code or data, with location),
`[observed]` or `[assumption]`. Production data was read with read-only queries (states, codes and times only — no
ticket contents, tokens or personal data).

## 1. Summary

- [fact] The architecture the brief asks for **already exists and is sound**: cloud queue → authenticated agent
  pulling over HTTPS → agent opens raw TCP 9100 to the printer → agent acknowledges. The cloud never connects to a
  printer address; LAN addresses must be RFC 1918 IPv4 (`lib/print/address.ts`). No third-party print service and no
  virtual printer are involved.
- [fact] The current TVS RP 3230 failure is **not an application fault**. Production shows every job for
  `192.168.1.103:9100` failing identically — `TIMEOUT: did not accept a connection within 5 s` (9 test prints on
  2026-10-07, 3 attempts each) — and the printer's health reported `OFFLINE` by a live agent at 2026-10-08 02:46 UTC.
  That matches the owner's manual test (PC 192.168.1.4 cannot ping 192.168.1.103). The same software path has
  printed before: 11 test tickets and 1 KOT are `PRINTED` in this tenant.
- The real gaps are in **diagnosis and resilience**, not architecture: a connect timeout is reported with the same
  code the runbook explains as "out of paper"; a KOT gives up after ~30 s of printer downtime; there is no on-demand
  "Test connection"; "Printed" means "bytes handed to the printer's TCP socket", not "paper came out"; one dead
  printer delays every other printer on the same agent; the agent needs Node.js pre-installed and is still branded
  RasoiOS; non-Latin text (Telugu) prints as `?`.

## 2. Immediate actions for the TVS RP 3230 (no code needed)

1. **Find the printer's current address.** Its DHCP is ON, so `192.168.1.103` from an old self-test may no longer be
   its address. Power-cycle it while holding FEED to print a fresh self-test, or look for its MAC in the router's DHCP
   client list.
2. **Let FlowDineOS look for it:** Printing → Printers → **Find nearby printers** with the online agent. The agent
   scans its own /24 on port 9100 and mDNS (ADR-015). If the printer is on the same network it will be listed with its
   real address.
3. **Same network, same router:** plug the printer into a LAN port of the *same* router as the PC (not the WAN port,
   not a separate switch or mesh node with client/AP isolation). From the PC, `ping <address>` must answer before
   anything else can work; `Test-NetConnection <address> -Port 9100` must report `TcpTestSucceeded : True`.
4. **Then fix the address:** reserve it in the router (DHCP reservation) or set a static IP on the printer, and enter
   that in FlowDineOS.
5. **Tidy the configuration** [fact, production data]:
   - **Two active agents:** `akpa` (…9042) and `Akshaya` (…8586) are both paired, both online, and appear to be on the
     same Windows PC.
   - **Duplicate printers:** each agent has an active printer at `192.168.1.103:9100` (`KKKKKKK`, `Hasanam`), so every
     ticket for that address would be attempted by whichever agent it is assigned to. Keep one agent and one printer;
     revoke the other agent.
   - **Wrong subnet:** printer `esres` is at `192.168.0.31`, a different subnet from the PC (192.168.1.x), so it cannot
     be reached from there.
   - **Misconfigured, inactive:** printer `TVS` is set to USB with an IP address as its USB name (inactive, but
     confusing).
   - **Stale pairings:** 9 `PENDING_PAIRING` agents with long-expired codes clutter the Agents list.

## 3. Architecture map (as built)

```
Order / KOT created ──► lib/services/kot.ts ──► enqueueKotPrintJobs (lib/services/printing.ts:221)
  payment ──► queueReceiptForPayment (:315)       test ──► createTestPrintJob (:390)
        │  renders the ticket ONCE on the server: lib/print/render-kot.ts / render-receipt.ts / render-test.ts
        ▼
print_jobs row (PENDING, payload = PrintDocument JSON, dedupe_key UNIQUE per tenant, max_attempts 3)
        │  agent polls every 3 s ± 1 s:  POST /api/v1/print-agent/jobs/claim   (bearer token, SHA-256 at rest)
        ▼
claimJobs (lib/data/printing.ts:506) — FOR UPDATE SKIP LOCKED, only this tenant AND this agent's printers,
        lease 60 s, attempt + 1, fresh claim_token        → PROCESSING
        ▼
agent runner (print-agent/src/runner.ts:197) — journal check → encodeDocument (escpos.ts) → transport.send
        LAN: print-agent/src/transports/lan.ts (connect 5 s, write 10 s)   USB: transports/usb.ts
        ▼
journal.record(jobId) (fsync, 24 h) → POST /jobs/{id}/ack {claimToken, PRINTED|FAILED, code}
        ▼
ackJob (lib/data/printing.ts:573) — same tenant + same agent + current claim token, row locked
        PRINTED (only path, BR-PRINT-01) | FAILED → PENDING with backoff 10 s, 20 s | FAILED terminal at 3/3
        ▼
console: app/restaurant/printing/printing-console.tsx — printers, agents, jobs; Test print, Retry (FAILED only),
         Deactivate, Revoke, Find nearby printers, archive history
heartbeat every 30 s: config refresh + TCP probe of each printer → printers.health ONLINE/OFFLINE/ERROR
```

Every layer the brief lists exists — queue, agent gateway, printer manager (`runner.ts`), adapters (`transports/`),
ESC/POS renderer (`escpos.ts` + `lib/print/render-*.ts`), status tracking (`print_jobs`, health), diagnostics
(probe + discovery), admin UI.

## 4. What is already right (keep it)

| Brief requirement | Status | Evidence |
|---|---|---|
| Cloud never connects to printer IPs (SSRF) | ✅ | only the agent opens sockets; `lib/print/address.ts` private IPv4 only, no hostnames; agent re-validates |
| Tenant + agent ownership on claim/ack | ✅ | `claimJobs` / `ackJob` filter by tenant **and** agent **and** assigned printers; other tenant's job = 404 |
| Pairing: one-time, short, hashed, rate-limited | ✅ | 10-min code, SHA-256 hash only, single use, `agent.pair` 5/15 min fail-closed |
| Agent token at rest | ✅ | SHA-256 hash + 8-char prefix; OS-protected file on the PC; revoke works on next request |
| Duplicate-print protection | ✅ (at-least-once + journal) | `dedupe_key` unique; claim token per lease; journal before ack; 409 STALE_CLAIM |
| No "Printed" without the agent | ✅ | `PRINTED` written only in `ackJob` |
| Printer not "online" just because the agent is | ✅ | health comes only from the agent's TCP probe |
| Per-printer port, 58/80 mm, KOT/receipt, kitchen-section routing | ✅ | `connectionAddress host:port`, `paperWidthMm`, `purpose`, `kitchenSectionId` |
| ESC/POS injection | ✅ | every string re-sanitised to printable ASCII before encoding |
| Audit of printer/agent changes, retries | ✅ | `print_job.*`, `printer.*`, `print_agent.*` actions |
| Automatic discovery optional, manual config kept | ✅ | ADR-015 |
| Tests | ✅ broad | unit: escpos, runner, transport, discovery, queue rules, document; integration: agent API, runtime, printing |

## 5. Defects and gaps (ranked)

| # | Finding | Impact | Evidence |
|---|---|---|---|
| D1 | **Connect timeout and write timeout share one code, `TIMEOUT`.** The runbook explains `TIMEOUT` as "reachable but not accepting data — often out of paper". An unreachable printer (the RP 3230 case) is therefore diagnosed as a paper problem. | Wrong troubleshooting | `transports/lan.ts:54,58`; `operations/print-agent.md` §7 |
| D2 | **KOTs give up after ~30 s of printer downtime.** 3 attempts, backoff 10 s → 20 s, then terminal FAILED needing a manual Retry. A printer rebooting or a cable re-seated loses the automatic KOT. | Missed kitchen tickets | `state-machine.ts` `RETRY_BASE_MS`, `maxAttempts @default(3)` |
| D3 | **"Printed" = bytes handed to the socket.** `socket.end()` resolves when data is flushed to the OS; a printer with its cover open or out of paper often still accepts TCP data. No ESC/POS status query (DLE EOT) is made. | A job can show Printed with no paper | `transports/lan.ts:59-60`, `escpos.ts` (no status commands) |
| D4 | **Unknown-delivery state not distinguished.** A write timeout after the connection opened may have delivered part or all of a ticket, yet it is retried like a refused connection. | Possible duplicate/partial KOT | `runner.ts:228-236` |
| D5 | **No on-demand Test connection** with a structured result; only a test *print* (a real job) and the 30 s heartbeat probe. | Slow, noisy diagnosis | `printing-console.tsx` actions |
| D6 | **Head-of-line blocking.** The agent claims one job at a time across all its printers; an unreachable printer costs 5 s per attempt and delays tickets for healthy printers. | Kitchen delays | `runner.ts:99` `claim(1)` |
| D7 | **No cancel for queued jobs.** Only FAILED → Retry, and archive of finished jobs. | Stuck queue needs deactivation | `retryJob` only; UI has no Cancel |
| D8 | **Installer needs Node.js 22 pre-installed;** runs as a scheduled task, not a Windows service; branded "RasoiOS" (paths, task name). | Install friction, branding | `operations/print-agent.md` §1–3 |
| D9 | **Non-Latin text prints as `?`** (Telugu, Hindi). Thermal printers have no Indic fonts; this needs raster (bitmap) printing. | Dish names unreadable | `escpos.ts:64-66` |
| D10 | No printer **profile** (code page, cut type, buzzer, QR support); one ESC/POS dialect for all printers. RP 3230 not hardware-verified. | Unknown on new models | `escpos.ts` `ESCPOS` |
| D11 | Expired `PENDING_PAIRING` agents stay listed forever; the UI allows two agents to own printers with the same address without warning. | Confusing setup (seen in production) | §2 item 5 |
| D12 | Job payloads (ticket JSON) kept until purge. | Data retention | `print_jobs.payload` |

Not a defect: **offline internet.** Orders are created in the cloud, so during an outage there are no new KOTs to
print; a job already claimed finishes, and the journal prevents duplicates on reconnect. A local offline queue would
contradict the cloud-first architecture and is not recommended.

## 6. Where the brief and the current design differ — owner decisions needed

1. **State machine size.** The brief lists 16 states. The cloud cannot observe sub-second agent steps (connecting,
   connected, sending) without extra round trips per ticket. Proposed instead (7 states):
   - `QUEUED` and `IN_PROGRESS` (claimed, leased).
   - `DELIVERED`: bytes accepted by the printer **and**, where the printer supports it, a status check before and after
     shows no paper or cover fault.
   - `RETRYING` and `NEEDS_ATTENTION`: delivery unknown; staff choose Reprint or Mark done.
   - `FAILED` and `CANCELLED`.

   "Printed" in the UI becomes "Delivered to printer"; physical output is confirmed only in hardware acceptance.
2. **Retry policy for KOTs.** Proposed: keep retrying with backoff 2 → 4 → 8 → 15 → 30 s (capped) for up to
   **30 minutes**. During that time the console shows "Kitchen Printer offline — N waiting, retrying automatically". After
   30 minutes the job moves to `FAILED` and a manager is notified. Receipts and test prints keep a short policy.
3. **Telugu / Indic printing** needs bitmap rendering on the agent with an embedded font (Noto Sans Telugu, SIL Open
   Font License). This is a real feature (P2), not a fix.
4. **Agent packaging:** ship the agent as a self-contained Windows executable registered as a Windows service, so no
   Node.js install is needed. Existing RasoiOS installs must keep working: same data folder, migrated on upgrade.

## 7. Implementation plan (Phase 2)

### P0 — critical (makes today's failure obvious and stops lost KOTs)

| Task | Files | Tests |
|---|---|---|
| Split error codes: `PRINTER_CONNECT_TIMEOUT`, `PRINTER_CONNECTION_REFUSED`, `PRINTER_HOST_UNREACHABLE`, `PRINTER_WRITE_TIMEOUT`, `PRINTER_WRITE_FAILED`, `PRINTER_ADDRESS_INVALID`; map each to a plain sentence for staff ("Kitchen Printer can't be reached from the print agent's computer") and a technical line for admins ("TCP 192.168.1.103:9100 — no answer within 5 s"). Fix the runbook table. | `print-agent/src/transports/lan.ts`, `transports/types.ts`, `lib/print/error-codes.ts` (new), `printing-console.tsx`, `operations/print-agent.md` | unit: transport mapping per errno; UI copy |
| **Test connection** (no print job): admin clicks → a `printer_check` request row → agent picks it up with its next claim (same pattern as discovery, ADR-015) → connects, closes → reports `{ ok, code, elapsedMs }` → console shows the result. Cloud never connects. | migration `printer_checks` (tenant_id, printer_id, agent_id, status, result, times), `lib/services/printing.ts`, agent `runner.ts`, `/api/v1/print-agent/checks/{id}`, `printer-dialog.tsx` | integration: tenant/agent isolation, RBAC, expiry; agent unit test |
| KOT retry policy per job type (decision 6.2), console banner "N waiting, retrying". | `state-machine.ts`, `createPrintJob` max attempts by type, `printing-console.tsx` | unit: backoff schedule; integration: 30-min cap |
| Hardware acceptance checklist for TVS RP 3230 (below, §9). | this folder | manual |

### P1 — high

| Task | Notes |
|---|---|
| Delivery truth (decision 6.1): ESC/POS real-time status `DLE EOT 1–4` before and after sending, where the printer answers; `NEEDS_ATTENTION` on write timeout after connect; UI label "Delivered to printer". | RP 3230 support for DLE EOT over Ethernet must be verified on hardware first. |
| Cancel a queued/attention job (audited), staff Reprint/Mark done for `NEEDS_ATTENTION`. | Only TENANT_ADMIN/MANAGER; never for PRINTED/DELIVERED. |
| Per-printer lanes in the agent: claim per printer, one in-flight job per printer, so a dead printer never delays others. | `claim` gains `printerIds`; server keeps tenant/agent checks. |
| Printer profiles: `GENERIC_ESCPOS_80`, `GENERIC_ESCPOS_58`, `TVS_RP3230` (code page, partial cut, buzzer, QR support flags). | New column `profile` (default generic) — additive migration. |
| Windows packaging: single executable + Windows service (auto-start, restart on failure), FlowDineOS branding, upgrade migrates `%ProgramData%\RasoiOS\PrintAgent` in place, uninstall. | Keep the scheduled-task installer until the service build is proven. |
| Agents page: hide/expire stale pairings; warn when two active printers share one address. | |

### P2 — medium

- Telugu/Indic bitmap printing (decision 6.3).
- Job detail view: attempts, agent, codes.
- Queue filters by printer/station/date.
- Clear payloads of delivered jobs after 30 days, keeping the metadata.

### P3 — optional

- QR on receipts (UPI / feedback link).
- Optional buzzer on new KOT.
- Agent-side status page.

### Every phase

- Additive migrations only; no destructive change.
- Tenant/agent isolation tests for every new route.
- Audit for new actions; runbook updated.
- `knowledge/implementation/printing.md` written from this audit once P0 lands.

## 8. Risks

- **[assumption] DLE EOT status over raw TCP on the RP 3230** — TVS documents ESC/POS compatibility; whether real-time
  status answers over Ethernet is unverified. P1 delivery-truth work depends on it; without it "Delivered" stays
  "accepted by the printer's network port".
- **Two agents on one PC** (production today) could both print the same ticket if both own a printer at the same
  address. Resolve in §2.5 before go-live.
- **Physical output** can only be confirmed by a person during acceptance; no software status replaces that.

## 9. Hardware acceptance checklist — TVS RP 3230 (Ethernet, ESC/POS, 80 mm / 48 col)

**Prerequisite.** From the agent PC, ping the printer and run `Test-NetConnection <ip> -Port 9100`: it must report
`TcpTestSucceeded True`.

| # | Step | Expected | Pass |
|---|---|---|---|
| 1 | Test connection (P0) / heartbeat | Printer shows Online | ☐ |
| 2 | Test print | Ticket prints, 48 columns aligned, partial cut | ☐ |
| 3 | Dine-in order with 3 items, variants, add-ons, a note | KOT prints once, all lines readable | ☐ |
| 4 | 10 orders within 1 minute | 10 KOTs, in order, no duplicates | ☐ |
| 5 | Long item names (60+ chars) and a 3-digit quantity | Wrapped, nothing past the edge | ☐ |
| 6 | Printer powered off → order → printer on | KOT prints automatically after power-on (P0 retry) | ☐ |
| 7 | Paper out → order | Not shown as delivered (P1) / clear error | ☐ |
| 8 | Cover open → order | As 7 | ☐ |
| 9 | Restart the agent PC mid-queue | Agent returns by itself, queue drains, no duplicates | ☐ |
| 10 | Unplug router 2 min | Agent reconnects; nothing lost or doubled | ☐ |
| 11 | Revoke agent | Agent stops; jobs wait; console shows agent offline | ☐ |

Physical paper output is confirmed by the person running the test, never by an API response.
