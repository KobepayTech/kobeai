#!/bin/bash
# ============================================
# INSTALL KOBEAI ADMIN CLI
# ============================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}Installing KobeAI Admin CLI...${NC}"

INSTALL_DIR="/usr/local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Module directory holds models.sh / system.sh; the dispatcher looks them up
# via its own SCRIPT_DIR, so install to a fixed module directory and point a
# wrapper at it.
MODULE_DIR="/opt/kobeai/admin-cli"
mkdir -p "$MODULE_DIR"
cp "$SCRIPT_DIR/models.sh" "$MODULE_DIR/"
cp "$SCRIPT_DIR/system.sh" "$MODULE_DIR/"
cp "$SCRIPT_DIR/kobeai-admin" "$MODULE_DIR/"
chmod +x "$MODULE_DIR/kobeai-admin"

# Wrapper on PATH
cat > "$INSTALL_DIR/kobeai-admin" <<'WRAP'
#!/bin/bash
exec /opt/kobeai/admin-cli/kobeai-admin "$@"
WRAP
chmod +x "$INSTALL_DIR/kobeai-admin"

ln -sfn "$MODULE_DIR" "$HOME/.kobeai"

echo -e "${GREEN}KobeAI Admin CLI installed!${NC}"
echo ""
echo "Usage: kobeai-admin help"
echo ""
echo "Quick commands:"
echo "  kobeai-admin models install    # Install all AI models"
echo "  kobeai-admin system status     # Check services"
echo "  kobeai-admin health            # Full health check"
