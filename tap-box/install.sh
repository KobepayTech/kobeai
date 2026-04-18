#!/bin/bash
# =============================================================================
# KobeAI Tap-Box installer for Raspberry Pi OS (Debian 12+)
# Run as root on a fresh Pi:   sudo bash install.sh
# =============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This installer must run as root (use sudo)." >&2
  exit 1
fi

INSTALL_DIR=/opt/kobeai-tap-box
ENV_FILE=/etc/default/kobeai-tap-box
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing system packages"
apt-get update
apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip \
  cups cups-bsd cups-client printer-driver-all \
  libusb-1.0-0 libnfc-bin libnfc-dev pcscd pcsc-tools

echo "==> Allowing 'pi' user to manage CUPS"
usermod -aG lpadmin pi 2>/dev/null || true

echo "==> Creating $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/tap_box_daemon.py" "$INSTALL_DIR/"

echo "==> Creating Python virtualenv"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install requests nfcpy

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Writing default config to $ENV_FILE (edit before starting)"
  cat > "$ENV_FILE" <<EOF
# KobeAI Tap-Box configuration
KOBEAI_API_BASE=http://192.168.1.100:8000
KOBEAI_TAP_BOX_ID=tap-lib-1
KOBEAI_PRINTER_ID=printer-lib-01
KOBEAI_CUPS_PRINTER=Epson_L3250
KOBEAI_TAP_BOX_SECRET=change-me-to-match-the-server
KOBEAI_NFC_PATH=usb
KOBEAI_POLL_INTERVAL_S=1.5
EOF
fi

echo "==> Installing systemd service"
cat > /etc/systemd/system/kobeai-tap-box.service <<EOF
[Unit]
Description=KobeAI Tap-Box NFC + Print daemon
After=network-online.target cups.service
Wants=network-online.target cups.service

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/tap_box_daemon.py
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable kobeai-tap-box.service

cat <<DONE

================================================================
KobeAI Tap-Box installed.

Next steps:
  1. Edit  $ENV_FILE  with your real API URL, secrets, and printer name.
  2. Add the printer to CUPS:
        lpadmin -p Epson_L3250 -E -v usb://EPSON/L3250 -m everywhere
     (or use the CUPS web UI at http://localhost:631)
  3. Start the service:
        systemctl start kobeai-tap-box
        journalctl -u kobeai-tap-box -f
================================================================
DONE
