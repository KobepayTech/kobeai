#!/bin/bash
# =============================================================================
# KobeAI first-boot bootstrap — runs ONCE on the very first boot of the freshly
# installed OS. Decides whether this box is a master or a worker by reading
# /etc/kobeai-role (written by the autoinstall late-commands), then:
#
#   master:  install Docker, clone repo, run deploy/school-server/install.sh
#   worker:  install Docker, run a tiny Ollama-only docker-compose, pull models
#
# After a successful run it touches /var/lib/kobeai/firstboot-done so the
# systemd unit becomes a no-op forever.
#
# Logs go to journalctl -u kobeai-firstboot AND to /var/log/kobeai-firstboot.log
# =============================================================================
set -euo pipefail

LOG=/var/log/kobeai-firstboot.log
exec > >(tee -a "$LOG") 2>&1
echo "==> KobeAI firstboot starting at $(date -Is)"

ROLE="$(cat /etc/kobeai-role 2>/dev/null || echo unknown)"
PAYLOAD=/opt/kobeai-payload

if [[ "$ROLE" != "master" && "$ROLE" != "worker" ]]; then
  echo "FATAL: /etc/kobeai-role is missing or invalid (got '$ROLE')." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Wait for network — first boot is often a few seconds before DNS settles.
# -----------------------------------------------------------------------------
for i in {1..30}; do
  if curl -fsSL --max-time 3 https://download.docker.com/ -o /dev/null; then
    break
  fi
  echo "    waiting for network ($i/30)…"
  sleep 2
done

# -----------------------------------------------------------------------------
# 2. Install Docker Engine + compose plugin (idempotent).
# -----------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
                     docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

# Allow the kobeai user to use docker without sudo.
usermod -aG docker kobeai 2>/dev/null || true

# -----------------------------------------------------------------------------
# 3. Role-specific provisioning
# -----------------------------------------------------------------------------
mkdir -p /var/lib/kobeai

if [[ "$ROLE" == "master" ]]; then
  echo "==> Provisioning MASTER node"
  bash "$PAYLOAD/master/install-master.sh"
else
  echo "==> Provisioning WORKER node"
  bash "$PAYLOAD/worker/install-worker.sh"
fi

# -----------------------------------------------------------------------------
# 4. Mark done and disable the unit so it never runs again.
# -----------------------------------------------------------------------------
touch /var/lib/kobeai/firstboot-done
systemctl disable kobeai-firstboot.service || true

echo "==> KobeAI firstboot complete at $(date -Is)"
