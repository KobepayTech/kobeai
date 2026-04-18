#!/bin/bash
# =============================================================================
# KobeAI WORKER first-boot — runs once after the autoinstall reboots into the
# freshly installed Ubuntu. Sets up Ollama-only on this box, listening on the
# LAN at port 11434 so the master at 192.168.1.10 can reach it.
# =============================================================================
set -euo pipefail

PAYLOAD=/opt/kobeai-payload
KOBEAI_HOME=/opt/kobeai
mkdir -p "$KOBEAI_HOME/data/ollama"

# -----------------------------------------------------------------------------
# 1. Drop in the worker compose file (just Ollama, bound to all interfaces but
#    firewalled by ufw to allow only the master's IP — see autoinstall).
# -----------------------------------------------------------------------------
cp "$PAYLOAD/worker/docker-compose.yml" "$KOBEAI_HOME/docker-compose.yml"
cd "$KOBEAI_HOME"
docker compose up -d

# -----------------------------------------------------------------------------
# 2. Wait for Ollama to come up, then pull the models.
#    Default set is sized for the master's RAM tier (Mistral 7B + Phi 2.7B +
#    embeddings). Override with KOBEAI_WORKER_MODELS env at firstboot time.
# -----------------------------------------------------------------------------
echo "==> Waiting for Ollama"
for i in {1..30}; do
  if curl -fsSL --max-time 2 http://127.0.0.1:11434/api/version >/dev/null; then
    break
  fi
  sleep 2
done

MODELS="${KOBEAI_WORKER_MODELS:-phi:2.7b mistral:7b nomic-embed-text}"
for model in $MODELS; do
  echo "==> Pulling $model"
  docker exec kobeai-ollama ollama pull "$model" || echo "    !! failed to pull $model"
done

# -----------------------------------------------------------------------------
# 3. Final summary.
# -----------------------------------------------------------------------------
clear
cat <<EOF

================================================================
  KobeAI WORKER node is ready.
================================================================

  Ollama listening on:  http://192.168.1.11:11434

  Allowed clients:      192.168.1.10  (the master, via ufw)
  Models pulled:        $MODELS

  Health check:
    curl http://192.168.1.11:11434/api/tags

  Logs:
    docker logs -f kobeai-ollama
    journalctl -u kobeai-firstboot

================================================================
EOF
