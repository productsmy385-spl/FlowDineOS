#!/bin/sh
# Installs the FlowDineOS print agent on Linux / Raspberry Pi OS with systemd.
#
#   sudo sh install.sh https://app.example.com ABCD2345
#
# 1. Checks Node.js >= 22.  2. Verifies the bundle's SHA-256.  3. Creates the unprivileged `flowdineos-agent` user (in
# group lp for USB printers).  4. Pairs as that user, so the token file is 0600 and owned by it.  5. Enables the service.
set -eu

SERVER_URL="${1:?usage: sudo sh install.sh <server-url> <pairing-code>}"
PAIRING_CODE="${2:?usage: sudo sh install.sh <server-url> <pairing-code>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE=rasoios-print-agent.cjs
INSTALL_DIR=/opt/flowdineos-print-agent
DATA_DIR=/var/lib/flowdineos-print-agent
LEGACY_DATA_DIR=/var/lib/rasoios-print-agent

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Install Node.js 22 LTS or later." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node.js $NODE_MAJOR is too old. Install Node.js 22 LTS or later." >&2; exit 1; }

cd "$HERE"
sha256sum -c SHA256SUMS

AGENT_USER=flowdineos-agent
if id rasoios-agent >/dev/null 2>&1 && ! id flowdineos-agent >/dev/null 2>&1; then
  # Preserve existing legacy user if present
  AGENT_USER=rasoios-agent
else
  id flowdineos-agent >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin flowdineos-agent
fi
getent group lp >/dev/null 2>&1 && usermod -a -G lp "$AGENT_USER"

install -d -m 0755 "$INSTALL_DIR"
install -m 0644 "$BUNDLE" "$INSTALL_DIR/$BUNDLE"
install -d -m 0700 -o "$AGENT_USER" -g "$AGENT_USER" "$DATA_DIR"

# Migrate legacy data if present and new directory is empty
if [ -d "$LEGACY_DATA_DIR" ] && [ ! -f "$DATA_DIR/credentials.json" ] && [ -f "$LEGACY_DATA_DIR/credentials.json" ]; then
  cp -p "$LEGACY_DATA_DIR"/* "$DATA_DIR/" 2>/dev/null || true
  chown -R "$AGENT_USER:$AGENT_USER" "$DATA_DIR"
fi

# Pair as the service user so config.json / credentials.json are created with its ownership (token file 0600).
runuser -u "$AGENT_USER" -- env FLOWDINEOS_AGENT_HOME="$DATA_DIR" node "$INSTALL_DIR/$BUNDLE" pair "$PAIRING_CODE" --server "$SERVER_URL"

SERVICE_SRC="flowdineos-print-agent.service"
[ -f "$SERVICE_SRC" ] || SERVICE_SRC="rasoios-print-agent.service"
install -m 0644 "$SERVICE_SRC" /etc/systemd/system/flowdineos-print-agent.service
systemctl daemon-reload
systemctl enable --now flowdineos-print-agent.service
echo "Installed. Check Printing -> Agents in FlowDineOS: this device should show as online within a minute."
echo "Logs: journalctl -u flowdineos-print-agent -f"
