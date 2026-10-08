---
title: "Print Agent — Install, Pair, Update, Troubleshoot"
document_type: "Runbook"
project: "Restaurant SaaS Platform"
project_owner: "Gopala Krishna"
slice: "SLICE-01"
created: "2026-09-23"
last_updated: "2026-09-23"
related_decisions: ["RASOIOS-ADR-004", "RASOIOS-ADR-007"]
related_documents: ["../implementation/slice-01/tasks.md", "../implementation/slice-01/open-questions.md"]
---

# Print Agent — Install, Pair, Update, Troubleshoot

The print agent is a small Node.js program that runs on one computer inside the restaurant. It is the only thing
that talks to the printers: the cloud app queues jobs, the agent claims them, prints them over the LAN (Wi-Fi or
Ethernet, raw TCP) or USB, and reports the result (ADR-004, ADR-007). The agent only connects out over HTTPS; it
opens no port on the restaurant network.

Supported (Q-010, answered 2026-09-23): **Windows 10/11** and **Linux with systemd** (including Raspberry Pi OS).
Node.js 22 LTS or later must be installed.

Code: [`print-agent/`](../../print-agent/) · simulator: [`tools/printer-simulator/`](../../tools/printer-simulator/) ·
release workflow: [`.github/workflows/print-agent-release.yml`](../../.github/workflows/print-agent-release.yml).

## 1. Get the release

Releases are built by CI from a `print-agent-v<version>` tag and attached to the GitHub release as
`rasoios-print-agent-<version>-windows.zip` and `…-linux.zip`, each with the bundle, `SHA256SUMS` and the installer.
To build locally instead: `npm ci && npm run agent:build` → `print-agent/dist/`.

## 2. Printers first

- **Wi-Fi / Ethernet printer:** give it a fixed IP address (DHCP reservation on the router or the printer's own
  network menu — most ESC/POS printers print their current IP when powered on holding FEED). Raw printing is usually
  port 9100. In RASOIOS → Printing → Printers, add it as **LAN** with the address, e.g. `192.168.1.50:9100`
  (the port can be left out when it is 9100). Only private addresses (10.x, 172.16–31.x, 192.168.x) are accepted.
- **USB printer on Windows:** install the vendor driver, then share the printer (Printer properties → Sharing) with a
  simple share name such as `KitchenPrinter`. Enter that share name as the **USB** address.
- **USB printer on Linux:** plug it in; it appears as `/dev/usb/lp0`. Enter `lp0` as the **USB** address.
- Choose the purpose — **KOT** (kitchen), **Receipt** (customer bill) or both — the paper width (58/80 mm) and, for
  kitchen printers, the kitchen section.

## 2a. Find nearby printers (automatic discovery)

Printing → Printers → **Find nearby printers** (TENANT_ADMIN). The chosen online agent searches its own network for
~3 s: DNS-SD/mDNS (`_pdl-datastream._tcp`, `_ipp._tcp`, `_printer._tcp`, answered to a temporary port — the agent
never listens on 5353) and a connect-only probe of port 9100 on its own /24. Results show the address, protocol and
whether raw ESC/POS printing is possible ("IPP only" printers are not supported). **Add printer** opens the form
pre-filled and then sends a real test page. Not every printer announces itself — if none are found, add it manually.
Requirements: the agent PC and the printer on the same subnet; firewalls must allow outbound TCP 9100 and UDP 5353
replies (Windows Defender may ask once on first scan).

## 3. Install and pair

**Windows (recommended from agent 0.2.0):** run `FlowDineOS-Print-Agent-Setup.exe` — no Node.js needed; it
installs the **FlowDineOS Print Agent** Windows service and asks for the pairing code. See
[print-agent-windows.md](../implementation/print-agent-windows.md). The steps below are the older Node.js install.

In RASOIOS → Printing → Agents → **Pair a print agent**, name the PC and copy the one-time code (10 minutes, single use).
The dialog shows the exact command.

**Windows** — PowerShell *as Administrator*, in the unzipped folder:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ServerUrl https://<your-rasoios-site> -PairingCode ABCD2345
```

Installs to `%ProgramFiles%\RasoiOS\PrintAgent`, keeps its data (config, token, printed-job journal) in
`%ProgramData%\RasoiOS\PrintAgent` restricted to SYSTEM and Administrators, and registers the scheduled task
**RasoiOS Print Agent** (starts at boot as SYSTEM, restarts every minute on failure).

**Linux** — in the unzipped folder:

```sh
sudo sh install.sh https://<your-rasoios-site> ABCD2345
```

Creates the unprivileged `rasoios-agent` user (in group `lp`), installs to `/opt/rasoios-print-agent`, keeps data in
`/var/lib/rasoios-print-agent` (0700, token file 0600) and enables `rasoios-print-agent.service`.

Then, back in the console: assign the agent to each printer and press **Test print**. The printer's status turns
**Online** only after the agent has actually reached it; a job shows **Printed** only after the agent confirms it.

## 4. Check it

- `rasoios-print-agent status` (Linux: `sudo -u rasoios-agent env RASOIOS_AGENT_HOME=/var/lib/rasoios-print-agent node /opt/rasoios-print-agent/rasoios-print-agent.cjs status`;
  Windows: `node "%ProgramFiles%\RasoiOS\PrintAgent\rasoios-print-agent.cjs" status` as Administrator) lists the assigned
  printers and whether each one answers.
- Logs: Linux `journalctl -u rasoios-print-agent -f`; Windows Task Scheduler → RasoiOS Print Agent → History.
  Logs never contain the token or ticket contents.

## 5. Update

Run the new release's installer again with a fresh pairing code, or replace the bundle file and restart the service
(`Restart-ScheduledTask`/`Stop-ScheduledTask`+`Start-ScheduledTask`; `systemctl restart rasoios-print-agent`). The
installers verify the bundle's SHA-256 before installing.

## 6. Uninstall

`uninstall.ps1` (Administrator) or `sudo sh uninstall.sh`, then **revoke** the agent in Printing → Agents so its token
stops working even if a copy was kept.

## 7. Troubleshooting

| Symptom in the console | Likely cause | What to do |
|---|---|---|
| Agent **offline** / `AGENT_OFFLINE`, `AGENT_NOT_RESPONDING` | PC off, service stopped, no internet, or an agent older than 0.2.0 (cannot run Test connection) | Check the PC; `status` command; restart the service; update the agent |
| `CONNECTION_TIMEOUT` — "is unreachable — it did not answer" | Printer off, its IP changed (DHCP), or it is on another network / behind AP isolation | **Test connection**; `ping` and `Test-NetConnection <ip> -Port 9100` from the agent PC; **Find nearby printers**; reserve the IP (printing-hardware-checklist.md) |
| `PRINTER_UNREACHABLE` | No route to the address (wrong subnet, cable unplugged) | Same router and subnet as the agent PC; fix the address |
| `CONNECTION_REFUSED` | Printer answers but not on that port | Port is usually 9100; nothing else holding the printer |
| `CONNECTION_RESET` / `PRINT_SEND_FAILED` | Printer restarting or dropped the connection | Retried automatically |
| `DELIVERY_UNKNOWN` | Printer stopped part-way — paper out, cover open, or jam | Check paper and cover; **Retry** only if nothing came out (never retried automatically) |
| `PRINT_JOB_EXPIRED` | The printer stayed unavailable for the whole retry window (KOT 30 min) | Fix the printer, then **Retry** |
| `INVALID_PRINTER_CONFIGURATION` | Address not usable (public IP, hostname, a Windows share name on Linux) | Correct the address per §2 |
| USB error mentioning permission | Service account cannot write the device | Linux: ensure `rasoios-agent` is in group `lp`; Windows: re-share the printer |
| Agent stops with "Pair the agent again" | Agent revoked or re-paired elsewhere | Create a new code and re-run the installer |
| Occasional duplicate ticket | Agent crashed between printing and confirming *and* its journal was lost | Rare by design (at-least-once, ADR-007 §5); investigate crashes |

Development without hardware: `npm run printer:simulator -- --host 0.0.0.0 --port 9100` prints tickets as text; register
it with this PC's LAN IP, and run the agent with `npm run agent:dev -- pair <CODE> --server http://localhost:3000`
(`RASOIOS_AGENT_HOME` pointing at a scratch folder).
