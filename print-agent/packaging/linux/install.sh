#!/bin/sh
# Installs the FlowDineOS print agent on Linux / Raspberry Pi OS with systemd (S1-P17-T009, Q-010).
#
#   sudo sh install.sh https://app.example.com ABCD2345
#
# 1. Checks Node.js >= 22.  2. Verifies the bundle's SHA-256.  3. Creates the unprivileged `rasoios-agent` user (in
# group lp for USB printers).  4. Pairs as that user, so the token file is 0600 and owned by it.  5. Enables the service.
set -eu

SERVER_URL="${1:?usage: sudo sh install.sh <server-url> <pairing-code>}"
PAIRING_CODE="${2:?usage: sudo sh install.sh <server-url> <pairing-code>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE=rasoios-print-agent.cjs
INSTALL_DIR=/opt/rasoios-print-agent
DATA_DIR=/var/lib/rasoios-print-agent

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Install Node.js 22 LTS or later." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node.js $NODE_MAJOR is too old. Install Node.js 22 LTS or later." >&2; exit 1; }

cd "$HERE"
sha256sum -c SHA256SUMS

id rasoios-agent >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin rasoios-agent
getent group lp >/dev/null 2>&1 && usermod -a -G lp rasoios-agent

install -d -m 0755 "$INSTALL_DIR"
install -m 0644 "$BUNDLE" "$INSTALL_DIR/$BUNDLE"
install -d -m 0700 -o rasoios-agent -g rasoios-agent "$DATA_DIR"

# Pair as the service user so config.json / credentials.json are created with its ownership (token file 0600).
runuser -u rasoios-agent -- env RASOIOS_AGENT_HOME="$DATA_DIR" node "$INSTALL_DIR/$BUNDLE" pair "$PAIRING_CODE" --server "$SERVER_URL"

install -m 0644 rasoios-print-agent.service /etc/systemd/system/rasoios-print-agent.service
systemctl daemon-reload
systemctl enable --now rasoios-print-agent.service
echo "Installed. Check Printing -> Agents in RASOIOS: this device should show as online within a minute."
echo "Logs: journalctl -u rasoios-print-agent -f"
