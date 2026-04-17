#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/setup-ollama.sh
#
# One-shot installer for the on-prem KobeAI offline LLM (Ollama) on a school
# server. Run as root on a fresh Ubuntu 22.04+ box:
#
#   sudo MODEL=mistral:7b ./scripts/setup-ollama.sh
#
# What it does:
#   1. Installs Ollama (idempotent — re-running upgrades it).
#   2. Configures the systemd service to listen on 0.0.0.0:11434 so the
#      KobeAI api-server (running on the same school server, possibly in a
#      container or on a sibling machine) can reach it.
#   3. Pulls the configured model.
#   4. Smoke-tests the install with a single prompt.
#
# After this finishes, set the api-server env to:
#   AI_PROVIDER=ollama
#   OLLAMA_BASE_URL=http://127.0.0.1:11434   # or the LAN IP if separate hosts
#   OLLAMA_MODEL=$MODEL
#
# All traffic stays on the school LAN. No internet is required after the
# initial model pull.
# ---------------------------------------------------------------------------
set -euo pipefail

MODEL="${MODEL:-mistral:7b}"
# Bind to loopback by default — Ollama has NO authentication of its own, so
# 0.0.0.0 would expose model inference to anything on the school LAN.
# Override with LISTEN_HOST=0.0.0.0 only when the api-server runs on a
# different host AND the network perimeter (firewall/VPN) is locked down.
LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
LISTEN_PORT="${LISTEN_PORT:-11434}"

if [[ "${LISTEN_HOST}" == "0.0.0.0" ]]; then
  echo "WARNING: LISTEN_HOST=0.0.0.0 — Ollama API will be reachable from the LAN."
  echo "         Make sure your firewall restricts port ${LISTEN_PORT} to trusted hosts."
fi

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (try: sudo $0)" >&2
  exit 1
fi

echo "==> Installing / updating Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "    ollama already installed: $(ollama --version 2>/dev/null || echo unknown)"
fi

echo "==> Configuring systemd override (listen on ${LISTEN_HOST}:${LISTEN_PORT})"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/kobeai.conf <<EOF
[Service]
Environment="OLLAMA_HOST=${LISTEN_HOST}:${LISTEN_PORT}"
Environment="OLLAMA_KEEP_ALIVE=24h"
Environment="OLLAMA_NUM_PARALLEL=2"
EOF

systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama

echo "==> Waiting for Ollama to come up"
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${LISTEN_PORT}/api/tags" >/dev/null 2>&1; then
    echo "    Ollama is up"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo "ERROR: Ollama did not come up within 30s" >&2
    journalctl -u ollama --no-pager -n 50 >&2 || true
    exit 1
  fi
done

echo "==> Pulling model: ${MODEL}"
ollama pull "${MODEL}"

echo "==> Smoke-test"
ANSWER=$(curl -fsS "http://127.0.0.1:${LISTEN_PORT}/api/generate" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"Say hello in one short sentence.\",\"stream\":false}" \
  | sed -n 's/.*"response":"\([^"]*\)".*/\1/p')

if [[ -z "${ANSWER}" ]]; then
  echo "ERROR: smoke-test returned empty answer" >&2
  exit 1
fi
echo "    Model said: ${ANSWER}"

cat <<EOF

===========================================================================
Ollama is installed and serving on ${LISTEN_HOST}:${LISTEN_PORT}.
Model "${MODEL}" is ready.

Next: set these on the KobeAI api-server (e.g. /etc/default/kobeai or
your .env) and restart it:

  AI_PROVIDER=ollama
  OLLAMA_BASE_URL=http://127.0.0.1:${LISTEN_PORT}
  OLLAMA_MODEL=${MODEL}

Then visit the teacher dashboard -> "School AI" page to confirm it shows
"Online" and run a test prompt.
===========================================================================
EOF
