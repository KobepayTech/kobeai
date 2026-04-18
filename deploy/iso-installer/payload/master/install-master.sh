#!/bin/bash
# =============================================================================
# KobeAI MASTER first-boot — runs once after the autoinstall reboots into the
# freshly installed Ubuntu. Sets up the full school-server stack.
# =============================================================================
set -euo pipefail

PAYLOAD=/opt/kobeai-payload
KOBEAI_HOME=/opt/kobeai
REPO_URL="${KOBEAI_REPO_URL:-https://github.com/kobeai/kobeai.git}"
REPO_BRANCH="${KOBEAI_REPO_BRANCH:-main}"
REPO_DIR=/opt/kobeai-src

# -----------------------------------------------------------------------------
# 1. Get the source — prefer the bundled tarball baked into the ISO; fall back
#    to a git clone if it isn't there (online firstboot path).
# -----------------------------------------------------------------------------
if [[ -f "$PAYLOAD/kobeai-src.tar.gz" ]]; then
  echo "==> Extracting bundled source from ISO"
  mkdir -p "$REPO_DIR"
  tar -xzf "$PAYLOAD/kobeai-src.tar.gz" -C "$REPO_DIR" --strip-components=1
elif [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "==> Cloning KobeAI source from $REPO_URL ($REPO_BRANCH)"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
else
  echo "==> Source already present at $REPO_DIR — pulling latest"
  git -C "$REPO_DIR" pull --ff-only
fi

# -----------------------------------------------------------------------------
# 2. Generate strong secrets + the super-admin password ONCE.
# -----------------------------------------------------------------------------
mkdir -p "$KOBEAI_HOME"
CRED_FILE=/root/kobeai-credentials.txt

if [[ ! -f "$CRED_FILE" ]]; then
  SUPER_ADMIN_PW="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=')"
  WATCH_HCE_SECRET="$(openssl rand -hex 32)"
  cat > "$CRED_FILE" <<EOF
# =============================================================================
# KobeAI MASTER credentials — generated $(date -Is)
# KEEP THIS FILE SAFE.  Permissions: root only.
# =============================================================================
SUPER_ADMIN_LOGIN=admin@kobeai.school
SUPER_ADMIN_PASSWORD=$SUPER_ADMIN_PW
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET
WATCH_HCE_SECRET=$WATCH_HCE_SECRET
EOF
  chmod 600 "$CRED_FILE"
fi
# shellcheck disable=SC1090
source "$CRED_FILE"

# -----------------------------------------------------------------------------
# 3. Run the existing school-server bootstrap.
# -----------------------------------------------------------------------------
export KOBEAI_HOME
export SESSION_SECRET POSTGRES_PASSWORD WATCH_HCE_SECRET
bash "$REPO_DIR/deploy/school-server/install.sh" --skip-models

# -----------------------------------------------------------------------------
# 4. Drop in the LAN-only Caddy override + self-signed cert for kobeai.school.
# -----------------------------------------------------------------------------
mkdir -p "$KOBEAI_HOME/caddy"
cp "$PAYLOAD/master/Caddyfile" "$KOBEAI_HOME/caddy/Caddyfile"
cp "$PAYLOAD/master/docker-compose.caddy.yml" "$KOBEAI_HOME/docker-compose.caddy.yml"
cd "$KOBEAI_HOME"
docker compose --env-file "$KOBEAI_HOME/.env" \
  -f docker-compose.yml -f docker-compose.caddy.yml up -d caddy

# -----------------------------------------------------------------------------
# 5. Hosts-file entry so `kobeai.school` resolves locally on the master itself.
# -----------------------------------------------------------------------------
if ! grep -q "kobeai.school" /etc/hosts; then
  echo "192.168.1.10  kobeai.school" >> /etc/hosts
fi

# -----------------------------------------------------------------------------
# 6. Point the API at the worker for AI inference (best-effort: works whether
#    or not the worker is up yet — backend has a canned-answer fallback).
# -----------------------------------------------------------------------------
ENV_FILE="$KOBEAI_HOME/.env"
if grep -q "^OLLAMA_BASE_URL=" "$ENV_FILE"; then
  sed -i "s|^OLLAMA_BASE_URL=.*|OLLAMA_BASE_URL=http://192.168.1.11:11434|" "$ENV_FILE"
else
  echo "OLLAMA_BASE_URL=http://192.168.1.11:11434" >> "$ENV_FILE"
fi
if ! grep -q "^OLLAMA_MODEL=" "$ENV_FILE"; then
  echo "OLLAMA_MODEL=phi:2.7b" >> "$ENV_FILE"
fi
if ! grep -q "^AI_PROVIDER=" "$ENV_FILE"; then
  echo "AI_PROVIDER=ollama" >> "$ENV_FILE"
fi
docker compose --env-file "$ENV_FILE" -f "$KOBEAI_HOME/docker-compose.yml" up -d backend

# -----------------------------------------------------------------------------
# 7. Install operator tooling — kobeai-update + nightly kobeai-backup timer.
# -----------------------------------------------------------------------------
install -m 0755 "$PAYLOAD/master/kobeai-update" /usr/local/sbin/kobeai-update
install -m 0755 "$PAYLOAD/master/kobeai-backup" /usr/local/sbin/kobeai-backup
install -m 0644 "$PAYLOAD/master/kobeai-backup.service" /etc/systemd/system/kobeai-backup.service
install -m 0644 "$PAYLOAD/master/kobeai-backup.timer"   /etc/systemd/system/kobeai-backup.timer
systemctl daemon-reload
systemctl enable --now kobeai-backup.timer
echo "    enabled nightly backup timer (02:00 local time)"

# -----------------------------------------------------------------------------
# 8. Final on-screen summary.
# -----------------------------------------------------------------------------
clear
cat <<EOF

================================================================
  KobeAI MASTER node is ready.
================================================================

  URLs (LAN only):
    Parent App         https://kobeai.school/        (or https://192.168.1.10/)
    Teacher Dashboard  https://kobeai.school/teacher/
    API for watches    https://kobeai.school/api

  Super-admin login:
    email:     admin@kobeai.school
    password:  $SUPER_ADMIN_PW
    (also saved to $CRED_FILE — root only)

  AI worker expected at:  http://192.168.1.11:11434

  Useful commands:
    kobeai-admin health             Full system health check
    kobeai-admin models status      Which AI models are ready
    kobeai-update                   Pull latest source + redeploy
    kobeai-backup                   Run a backup now (USB or local)
    systemctl status kobeai-backup.timer   Nightly backup status
    journalctl -u kobeai-firstboot         First-boot log

  Backups:
    Plug in a USB drive labelled KOBEAI-BACKUP and the nightly job (02:00)
    will write to it; otherwise it writes to /opt/kobeai/backups/local.
    Keeps the last 14 backups by default.

  IMPORTANT — first sign-in:
    Change the super-admin password immediately, and consider rotating
    SESSION_SECRET in $KOBEAI_HOME/.env after onboarding.

================================================================
EOF
