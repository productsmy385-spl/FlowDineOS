#!/bin/sh
# Removes the FlowDineOS print agent. Also revoke the agent in Printing -> Agents so its token stops working.
#   sudo sh uninstall.sh [--keep-data]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
systemctl disable --now flowdineos-print-agent.service 2>/dev/null || true
systemctl disable --now rasoios-print-agent.service 2>/dev/null || true
rm -f /etc/systemd/system/flowdineos-print-agent.service /etc/systemd/system/rasoios-print-agent.service
systemctl daemon-reload
rm -rf /opt/flowdineos-print-agent
if [ "${1:-}" != "--keep-data" ]; then
  rm -rf /var/lib/flowdineos-print-agent
  userdel flowdineos-agent 2>/dev/null || true
fi
echo "FlowDineOS print agent removed."
