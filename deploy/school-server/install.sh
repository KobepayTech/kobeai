#!/bin/bash
# =============================================================================
# KobeAI School Server — one-shot bootstrap installer
#
# Run this on a fresh Ubuntu/Debian machine that has Docker installed.
#   curl -fsSL https://your-host/install.sh | sudo bash
# Or after cloning:
#   sudo bash deploy/school-server/install.sh
#
# What it does:
#   1. Verifies Docker + docker-compose are present
#   2. Creates /opt/kobeai layout (data dirs, .env, admin CLI)
#   3. Generates a strong SESSION_SECRET if one isn't set
#   4. Builds & starts every container
#   5. Pulls the default AI models (skip with --skip-models)
#   6. Prints the URLs the school staff should use
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

KOBEAI_HOME="${KOBEAI_HOME:-/opt/kobeai}"
SKIP_MODELS=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-models) SKIP_MODELS=true ;;
    --skip-build)  SKIP_BUILD=true  ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy/school-server"

banner() {
  echo -e "${BOLD}${GREEN}"
  echo "================================================================"
  echo "  KobeAI School Server Installer"
  echo "================================================================"
  echo -e "${NC}"
}

step() { echo -e "\n${CYAN}==>${NC} ${BOLD}$*${NC}"; }
ok()   { echo -e "  ${GREEN}OK${NC} $*"; }
warn() { echo -e "  ${YELLOW}!!${NC} $*"; }
die()  { echo -e "  ${RED}FAIL${NC} $*"; exit 1; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    die "This installer must run as root (use sudo)."
  fi
}

check_docker() {
  step "Checking Docker"
  command -v docker >/dev/null || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Docker daemon is not running. Try: systemctl start docker"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null; then
    COMPOSE="docker-compose"
  else
    die "Neither 'docker compose' nor 'docker-compose' is available."
  fi
  ok "Docker present ($($COMPOSE version --short 2>/dev/null || echo unknown))"
}

prepare_home() {
  step "Preparing $KOBEAI_HOME"
  mkdir -p "$KOBEAI_HOME"/{data/postgres,data/redis,data/ollama,backups,admin-cli}
  ok "Created data directories"

  # Sync the admin CLI so `kobeai-admin` works from anywhere.
  cp "$REPO_ROOT/admin-cli/kobeai-admin" "$KOBEAI_HOME/admin-cli/"
  cp "$REPO_ROOT/admin-cli/models.sh"    "$KOBEAI_HOME/admin-cli/"
  cp "$REPO_ROOT/admin-cli/system.sh"    "$KOBEAI_HOME/admin-cli/"
  chmod +x "$KOBEAI_HOME/admin-cli/kobeai-admin"
  cat > /usr/local/bin/kobeai-admin <<WRAP
#!/bin/bash
exec $KOBEAI_HOME/admin-cli/kobeai-admin "\$@"
WRAP
  chmod +x /usr/local/bin/kobeai-admin
  ok "Installed kobeai-admin to /usr/local/bin"

  # Sync the compose file & nginx config to a stable home so admin commands work.
  cp "$DEPLOY_DIR/docker-compose.yml" "$KOBEAI_HOME/docker-compose.yml"
  mkdir -p "$KOBEAI_HOME/nginx"
  cp "$DEPLOY_DIR/nginx/default.conf" "$KOBEAI_HOME/nginx/default.conf"
  ok "Synced docker-compose.yml + nginx config to $KOBEAI_HOME"
}

prepare_env() {
  step "Preparing .env"
  if [[ -f "$KOBEAI_HOME/.env" ]]; then
    ok ".env already exists — leaving it alone"
    return
  fi
  cp "$DEPLOY_DIR/.env.example" "$KOBEAI_HOME/.env"
  local secret
  secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$secret|" "$KOBEAI_HOME/.env"
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]]; then
    sed -i "s|^SERVER_URL=.*|SERVER_URL=http://$ip|" "$KOBEAI_HOME/.env"
    ok "Detected LAN IP $ip and wrote SERVER_URL"
  fi
  ok "Generated .env with a fresh SESSION_SECRET"
  warn "Edit $KOBEAI_HOME/.env to change DB password before exposing to the network."
}

build_and_start() {
  step "Building containers (this can take 5-15 minutes the first time)"
  cd "$REPO_ROOT"
  if $SKIP_BUILD; then
    ok "Skipping build (--skip-build)"
  else
    $COMPOSE -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$KOBEAI_HOME/.env" build
    ok "Images built"
  fi

  step "Starting services"
  # Use the synced compose file so it lives at $KOBEAI_HOME and admin CLI can find it.
  cd "$KOBEAI_HOME"
  $COMPOSE --env-file "$KOBEAI_HOME/.env" up -d
  ok "Services up"
}

install_models() {
  if $SKIP_MODELS; then
    warn "Skipping AI model download (--skip-models). Run 'kobeai-admin models install' later."
    return
  fi
  step "Pulling AI models (mistral:7b, phi:2.7b, deepseek-coder:6.7b, nomic-embed-text)"
  echo "    Total ~10 GB — this may take 15-30 minutes on a fast connection."
  echo "    Press Ctrl-C to skip; you can resume later with 'kobeai-admin models install'."
  sleep 3
  # Wait for ollama to be reachable before pulling
  for i in {1..30}; do
    if docker exec kobeai-ollama ollama list >/dev/null 2>&1; then break; fi
    sleep 2
  done
  for model in mistral:7b phi:2.7b deepseek-coder:6.7b nomic-embed-text; do
    echo -e "  ${CYAN}>>${NC} pulling $model"
    docker exec kobeai-ollama ollama pull "$model" || warn "Could not pull $model — keep going"
  done
  ok "Models installed"
}

print_summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ip="${ip:-<this-server-ip>}"

  echo ""
  echo -e "${BOLD}${GREEN}================================================================${NC}"
  echo -e "${BOLD}${GREEN}  KobeAI is running.${NC}"
  echo -e "${BOLD}${GREEN}================================================================${NC}"
  cat <<EOF

  ${BOLD}URLs to share with the school:${NC}
    Parent App         http://$ip/
    Teacher Dashboard  http://$ip/teacher/   (or http://$ip:3000)
    API (for watches)  http://$ip/api        (or http://$ip:8000)
    Ollama (debug)     http://$ip:11434

  ${BOLD}Useful commands:${NC}
    kobeai-admin health          Full system health check
    kobeai-admin system status   Service status
    kobeai-admin models status   Which AI models are ready
    kobeai-admin system logs     Tail all logs
    kobeai-admin backup          Snapshot DB + config

  ${BOLD}Configuration:${NC}  $KOBEAI_HOME/.env

EOF
}

banner
require_root
check_docker
prepare_home
prepare_env
build_and_start
install_models
print_summary
