FlowDineOS Print Agent for Windows
==================================

Runs on the restaurant PC and prints to the printers on your own network. FlowDineOS never
reaches into your network: this agent asks it for print jobs and sends them to your printers.
Node.js is NOT needed.

Install
  Run FlowDineOS-Print-Agent-Setup.exe (Administrator). Paste the pairing code from
  FlowDineOS -> Printing -> Agents -> Pair agent when asked (or leave it empty and pair later).
  The "FlowDineOS Print Agent" Windows service starts automatically, also after a restart.

Pair later (Administrator command prompt)
  "C:\Program Files\FlowDineOS Print Agent\FlowDineOS.PrintAgent.exe" pair <CODE>
  The service picks the pairing up within a minute.

Check
  "C:\Program Files\FlowDineOS Print Agent\FlowDineOS.PrintAgent.exe" status
  Logs: C:\ProgramData\FlowDineOS\PrintAgent\logs\agent.log (no tokens or ticket text are logged)

Upgrade
  Run the newer setup. The pairing is kept.

Uninstall
  Settings -> Apps -> FlowDineOS Print Agent. The pairing is kept unless you tick
  "Also remove this PC's pairing and print history". Revoke the agent in FlowDineOS afterwards.
