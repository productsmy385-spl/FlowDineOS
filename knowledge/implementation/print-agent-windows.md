---
title: "Print Agent for Windows — self-contained executable, service and installer"
document_type: "REFERENCE"
project: "FlowDineOS (RASOIOS)"
created: "2026-10-08"
related_decisions: ["RASOIOS-ADR-007", "RASOIOS-ADR-025"]
related_documents: ["printing.md", "printing-hardware-checklist.md", "../operations/print-agent.md"]
---

# Print Agent for Windows

The existing agent (`print-agent/src`, unchanged in behaviour) is packaged so a restaurant PC needs **no Node.js**:

```
print-agent/src  ──esbuild──▶ rasoios-print-agent.cjs ──Node SEA + postject──▶ FlowDineOS.PrintAgent.exe   (agent + Node runtime)
service-host/Program.cs ──csc (.NET Framework, ships with Windows)──▶ FlowDineOS.PrintAgent.Service.exe  (the Windows service)
installer.nsi ──NSIS 3──▶ FlowDineOS-Print-Agent-Setup.exe
```

Why a service host: Node.js cannot answer the Windows Service Control Manager. The ~150-line C# host is the service; it
runs `FlowDineOS.PrintAgent.exe run`, logs its output, restarts it with backoff, and stops it cleanly. No third-party
binary (WinSW/NSSM) is shipped; everything is built from this repository.

## Build

```
npm ci
npm run agent:build            # bundle (also builds the Linux tarball and the Windows zip served by the console)
npm run agent:build:windows    # Windows only: exe, service host, installer (needs NSIS 3; MAKENSIS=path if not on PATH)
```

Output: `print-agent/dist/windows/` — `FlowDineOS.PrintAgent.exe`, `FlowDineOS.PrintAgent.Service.exe`,
`FlowDineOS-Print-Agent-Setup.exe`, `SHA256SUMS`. The build fails if the exe does not report the package version with
`PATH` reduced to `System32` (proof it does not need Node.js). Nothing secret is read or embedded.

## Installed layout

| What | Where |
|---|---|
| Binaries, README, uninstaller | `C:\Program Files\FlowDineOS Print Agent\` (writable by Administrators only) |
| Pairing (`config.json`, `credentials.json`), journal | `C:\ProgramData\FlowDineOS\PrintAgent\` |
| Logs (rotated at 5 MB, one previous file) | `C:\ProgramData\FlowDineOS\PrintAgent\logs\agent.log` |
| Service | name `FlowDineOSPrintAgent`, display name **FlowDineOS Print Agent**, delayed automatic start |
| Service account | `NT SERVICE\FlowDineOSPrintAgent` (a per-service virtual account — not LocalSystem) |
| Apps & features | "FlowDineOS Print Agent", version, uninstall string |

Data folder ACL: inheritance removed; SYSTEM and Administrators full control; the service account modify. Every file the
agent writes inherits it, so the token is unreadable to ordinary users.

## Service behaviour

- Starts with Windows (delayed auto), restarts on failure (5 s, 30 s, 60 s; failure count reset daily), and the host
  itself restarts the agent with 2 s → 60 s backoff.
- Stop and shutdown: the host closes the agent's stdin (`FLOWDINEOS_SERVICE=1`), the agent finishes the ticket in flight
  and exits; after 20 s it is killed.
- Not paired / token revoked (agent exit 2): the service stays running and checks every 60 s, so pairing later needs no
  restart.
- No internet / server down: the agent's own backoff (1 s → 60 s); the service never crash-loops.
- The service host logs only the agent's own log lines, which are already redacted (no token, pairing code or ticket text).

## Install, upgrade, repair, uninstall

- **Fresh install:** Setup asks for the pairing code and the FlowDineOS address (default
  `https://flowdineos-production.up.railway.app`). Both are checked to contain only letters, digits and `:/.-_`, and the
  address must start with `https://`; they are passed to the agent as arguments, never through a shell. Pairing can be
  skipped and done later with `FlowDineOS.PrintAgent.exe pair <CODE>` from an Administrator prompt.
- **Upgrade / repair:** run Setup again. It stops the service, keeps the previous binaries as `*.rollback`, installs the
  new ones and starts the service. If writing files, registering the service, setting the folder permissions or starting
  the service fails, it restores the previous binaries, restarts them and stops with a message. Pairing is never touched.
- **Uninstall:** removes the service and binaries. The pairing and journal are kept unless "Also remove this PC's
  pairing and print history" is ticked (`/PURGE` silently). Revoke the agent in FlowDineOS afterwards.
- **Silent:** `Setup.exe /S [/PAIRINGCODE=ABCD2345] [/SERVER=https://…]`, `Uninstall.exe /S [/PURGE]`.

## Existing RasoiOS installations (compatibility)

The older agent ran as the **RasoiOS Print Agent** scheduled task with data in `C:\ProgramData\RasoiOS\PrintAgent`.
Setup:

1. Ends and deletes that scheduled task, so two agents never run with one token.
2. If the FlowDineOS data folder has no pairing, **copies** `config.json`, `credentials.json` and `journal.json` from
   the RasoiOS folder. The agent keeps the same identity: no re-pairing and no duplicate agent in the console, and
   tickets already printed are not printed again.
3. Never modifies or deletes the RasoiOS folder (it still holds a copy of the token, under its restrictive ACL).
   `C:\Program Files\RasoiOS\PrintAgent` is left as is. Delete both by hand once the new service has run for a while.

The agent itself also falls back to the RasoiOS folder when no FlowDineOS folder exists (`print-agent/src/paths.ts`), so a
plain Node.js install keeps working.

## Security review (2026-10-08)

| Risk | Handling |
|---|---|
| Unquoted service path | `binPath` is quoted; CI asserts it |
| Writable service directory | Program Files ACL (Administrators only); the service account cannot replace its own binary |
| Excessive privilege | Virtual service account, not LocalSystem; modify rights on its data folder only |
| Secrets in the installer / exe | None. The token is issued at pairing time and lives only in the protected data folder |
| Secrets in logs | Agent logs are redacted at source; CI fails if the test token appears in the log |
| Command injection via installer inputs | Code/address restricted to safe characters; passed as quoted arguments via `nsExec` (no shell) |
| DLL search order | The service host loads only .NET Framework assemblies from the GAC; the SEA exe is a single Node binary with no side-loaded DLLs; the install folder is not user-writable |
| Unsafe update | Updates only by running a newer Setup as Administrator (no self-update); rollback on failure |
| Unsigned binaries | **Not code-signed** — Windows SmartScreen will warn. There is no signing certificate in this project yet; until one is added (Authenticode, signtool in CI), builds are for internal testing and pilot restaurants only. Verify downloads against `SHA256SUMS` |

USB printers on Windows are reached through a printer share on `\\localhost\…`; whether the virtual service account can
open that share must be checked on site (LAN/Ethernet printers, the primary target, are unaffected).

## CI

Job `print-agent-windows` (`.github/workflows/ci.yml`), on `windows-latest`:

1. Builds the three binaries.
2. Runs the exe with no Node.js on `PATH`.
3. Installs silently over a placeholder RasoiOS pairing and checks:
   - the service is running, auto-starts, runs as the virtual account and has a quoted path;
   - the pairing was carried over unchanged and the RasoiOS folder was untouched;
   - the data folder ACL is correct;
   - the service keeps running with no reachable server;
   - the token is not in the log.
4. Upgrades, uninstalls (data kept), reinstalls, and uninstalls with `/PURGE` (data removed, RasoiOS folder still
   untouched).
5. Uploads the binaries as the `flowdineos-print-agent-windows` artifact.

[fact] First green run: CI run 37738341354 (2026-10-08). The service started as `NT SERVICE\FlowDineOSPrintAgent`, read
the carried-over RasoiOS pairing, and with no reachable server retried 1 s → 2 s → 4 s → 8 s → 16 s without crashing;
upgrade, uninstall (data kept) and purge were verified. Two real defects were found by this job and fixed before release:
installer helper functions swapped registers on return, and applying the data-folder ACL with `/T` stripped the
inherited entries of files already in it (a carried-over token became unreadable to the service).

The GitHub runner has Node.js installed system-wide. Running the exe with a reduced `PATH`, and the fact that the service
starts only `FlowDineOS.PrintAgent.exe`, show it does not use it. **A clean PC without Node.js is still to be tested by
hand (below).**

## Acceptance on a real PC (owner, before giving it to restaurants)

On a Windows 10/11 PC where `node --version` fails:

1. Download the `flowdineos-print-agent-windows` artifact from the latest CI run (GitHub → Actions → CI → artifact).
2. Check its `SHA256SUMS`.
3. Run Setup and enter a pairing code from Printing → Agents.
4. `services.msc` → **FlowDineOS Print Agent** is Running, startup type Automatic (Delayed Start).
5. FlowDineOS → Printing → Agents: the agent is Online and shows version 0.2.0.
6. Assign the printer, then Test connection and Test print.
7. Reboot → the service is running again and the agent is Online without logging in.
8. Run Setup again (upgrade) → still paired, still Online.
9. Uninstall → the service is gone, and `C:\ProgramData\FlowDineOS\PrintAgent` is still there.
10. Reinstall → paired again without a code.
11. On a PC that had the older RasoiOS agent: after Setup, the same agent (same name) shows Online, and no new agent
    appears.

## Troubleshooting

| Symptom | Check |
|---|---|
| Service stops right after starting | `C:\ProgramData\FlowDineOS\PrintAgent\logs\agent.log`; Event Viewer → Windows Logs → Application |
| Log says `agent.needs_pairing` | Pair: `"C:\Program Files\FlowDineOS Print Agent\FlowDineOS.PrintAgent.exe" pair <CODE>` (Administrator) |
| SmartScreen "Windows protected your PC" | Unsigned pilot build: More info → Run anyway, after checking SHA256SUMS |
| Agent offline but service running | Internet/firewall: outbound HTTPS to the FlowDineOS address must be allowed |

## Not included

The console's Pair-agent download still serves the Node.js zip, because Railway builds on Linux and cannot build the
Windows exe. The installer is published by CI as a build artifact. Linking the pairing dialog to a released
`FlowDineOS-Print-Agent-Setup.exe` (GitHub Release or object storage) is the next step once the PC test passes.
