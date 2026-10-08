---
title: "Printing — hardware acceptance checklist"
document_type: "CHECKLIST"
project: "FlowDineOS (RASOIOS)"
created: "2026-10-08"
related_documents: ["printing.md", "printing-audit-2026-10-08.md", "../operations/print-agent.md"]
---

# Printing — hardware acceptance checklist

Run this for every printer model before it is called supported, and on site for every new installation. **A step passes
only when a person sees the paper.** An HTTP 200, an accepted job, a "Delivered to printer" status or an open TCP
socket never counts as printed (raw TCP 9100 printers do not confirm paper).

Printer under test: **TVS-E RP 3230** · Ethernet · ESC/POS · 80 mm / 48 columns · TCP 9100 · auto-cutter.
Profile in FlowDineOS: **TVS-E RP 3230** (`TVS_RP3230`, `hardwareVerified: false` until this sheet is signed).

| # | Check | How | Expected | Pass |
|---|---|---|---|---|
| 1 | Printer powered on | Power LED | On, no error LED | ☐ |
| 2 | Paper loaded | Open cover, 80 mm roll, close | Paper LED off | ☐ |
| 3 | Ethernet connected | Cable into a **LAN** port of the same router as the agent PC | — | ☐ |
| 4 | Ethernet link LED | Printer's network port | Link LED on / blinking | ☐ |
| 5 | Printer IP identified | Hold FEED while powering on → self-test slip, or router's DHCP client list | Address noted: ____________ | ☐ |
| 6 | Printer and agent on one LAN | On the agent PC: `ping <ip>` | Replies (same /24 as the PC, e.g. 192.168.1.x) | ☐ |
| 7 | Test connection succeeds | FlowDineOS → Printing → Printers → **Test connection** | "Printer reachable", nothing printed | ☐ |
| 8 | TCP 9100 reachable | PowerShell: `Test-NetConnection <ip> -Port 9100` | `TcpTestSucceeded : True` | ☐ |
| 9 | Test print | **Test print** | Slip shows FLOWDINEOS PRINTER TEST, restaurant, printer, model, agent, station, time, 48 columns aligned, QR scans | ☐ |
| 10 | KOT | Place a real dine-in order with variants, add-ons, a note | One KOT, every line readable | ☐ |
| 11 | Auto-cut | Steps 9–10 | Partial cut after each ticket | ☐ |
| 12 | Multiple KOTs | 10 orders within one minute | 10 KOTs, in order, none twice | ☐ |
| 13 | Printer restart | Power off → order → power on | KOT prints by itself within ~5 min (retrying banner meanwhile) | ☐ |
| 14 | Agent restart | Restart the agent service mid-queue | Queue drains, nothing twice | ☐ |
| 15 | Router restart | Restart the router | Agent reconnects; KOTs print; nothing twice | ☐ |
| 16 | Printer offline/recovery | Unplug the printer's cable for 3 min, place an order, reconnect | "Printer offline — retrying automatically"; prints on reconnect | ☐ |
| 17 | Paper out | Remove paper, place an order | Note what the console shows: ____________ (P1: the agent does not yet read paper status) | ☐ |
| 18 | Cover open | Open cover, place an order | Note what the console shows: ____________ | ☐ |
| 19 | Queue recovery | Leave the printer off > 30 min, then on | KOT shows Failed (retries stopped); Retry prints it once | ☐ |
| 20 | Duplicate check | Count paper for steps 10–19 | Exactly one ticket per KOT | ☐ |

Tested by: __________ Date: __________ Agent version: __________ Result: PASS / FAIL

When every step passes, set `hardwareVerified: true` for the profile in `lib/print/profiles.ts` in the same change as
the signed sheet. Until then the profile is "manufacturer specification" only.

## Network troubleshooting (the 2026-10-07 case)

Observed: PC 192.168.1.4 → router 192.168.1.1 OK; PC → printer 192.168.1.103 no ping, TCP 9100 fails; printer link LED
on. Test connection shows **CONNECTION_TIMEOUT / Printer unreachable** with the agent **Online** — the application is
working; the network path is not. In order:

1. The printer's DHCP is on — 192.168.1.103 may be stale. Print a fresh self-test; check the router's client list.
2. **Find nearby printers** (the agent scans its own /24 for port 9100 and mDNS).
3. Same router, LAN port (not WAN), no guest network / AP isolation between PC and printer.
4. Reserve the address in the router (DHCP reservation) or set a static IP on the printer; update it in FlowDineOS.
5. Repeat steps 6–8 above before anything else.
