#!/bin/bash
# =============================================================================
# KobeAI ISO builder — assembles a customised Ubuntu 24.04 Server ISO that:
#   * Shows a KobeAI boot menu (Master / Worker / Live / Recovery)
#   * Installs Ubuntu unattended via cloud-init autoinstall
#   * On first boot of the installed system, runs install-master.sh or
#     install-worker.sh which sets up Docker + the full KobeAI stack
#
# Run this on a Linux box (Ubuntu/Debian recommended) or in WSL2 / Mac+Docker.
# Requires ~10 GB of free disk during the build.
#
# Usage:
#   sudo ./build-iso.sh                      # downloads Ubuntu ISO if needed
#   sudo ./build-iso.sh /path/to/ubuntu.iso  # use a local Ubuntu Server ISO
#
# Output:  ./out/kobeai-installer.iso
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${CYAN}==>${NC} ${BOLD}$*${NC}"; }
ok()   { echo -e "  ${GREEN}OK${NC} $*"; }
die()  { echo -e "  ${RED}FAIL${NC} $*"; exit 1; }
warn() { echo -e "  ${YELLOW}!!${NC} $*"; }

# Root is no longer required — we use 7z to extract (not loop mount).
# The script will refuse to scribble outside its own work/out dirs anyway.
if [[ "${KOBEAI_ALLOW_NONROOT:-1}" != "1" ]] && [[ $EUID -ne 0 ]]; then
  die "Run with sudo, or set KOBEAI_ALLOW_NONROOT=1 if your environment doesn't need it."
fi

UBUNTU_VERSION="${UBUNTU_VERSION:-24.04.1}"
UBUNTU_ISO_URL="https://releases.ubuntu.com/${UBUNTU_VERSION}/ubuntu-${UBUNTU_VERSION}-live-server-amd64.iso"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/build"
OUT="$HERE/out"
SRC_ISO="${1:-$WORK/ubuntu.iso}"
EXTRACT="$WORK/extract"
PAYLOAD_TGZ="$HERE/payload/kobeai-src.tar.gz"
FINAL_ISO="$OUT/kobeai-installer.iso"

mkdir -p "$WORK" "$OUT"

# -----------------------------------------------------------------------------
# 1. Toolchain check
# -----------------------------------------------------------------------------
step "Checking required tools"
for cmd in xorriso 7z curl rsync sed; do
  command -v "$cmd" >/dev/null || die "Missing: $cmd  (apt install xorriso p7zip-full curl rsync)"
done
ok "All build tools present"

# -----------------------------------------------------------------------------
# 2. Get Ubuntu base ISO
# -----------------------------------------------------------------------------
if [[ ! -f "$SRC_ISO" ]]; then
  step "Downloading Ubuntu ${UBUNTU_VERSION} server ISO (≈3 GB)"
  curl -fL "$UBUNTU_ISO_URL" -o "$SRC_ISO"
  ok "Downloaded to $SRC_ISO"
else
  ok "Using existing Ubuntu ISO at $SRC_ISO"
fi

# -----------------------------------------------------------------------------
# 3. Extract the ISO into a writable tree
# -----------------------------------------------------------------------------
step "Extracting Ubuntu ISO"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
7z -y x "$SRC_ISO" -o"$EXTRACT" >/dev/null
# 7z drops a useless [BOOT] dir — remove it
rm -rf "$EXTRACT/[BOOT]"
ok "Extracted to $EXTRACT"

# -----------------------------------------------------------------------------
# 4. Bake the KobeAI source tree into the payload (offline-capable install).
# -----------------------------------------------------------------------------
step "Packaging KobeAI source tree (excludes node_modules, build artefacts, .git)"
tar --exclude-vcs \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='dist' \
    --exclude='build' \
    --exclude='.cache' \
    --exclude='deploy/iso-installer/build' \
    --exclude='deploy/iso-installer/out' \
    -czf "$PAYLOAD_TGZ" \
    -C "$(dirname "$REPO_ROOT")" "$(basename "$REPO_ROOT")"
ok "Source tarball: $(du -h "$PAYLOAD_TGZ" | cut -f1)"

# -----------------------------------------------------------------------------
# 5. Inject autoinstall + payload into the ISO tree
# -----------------------------------------------------------------------------
step "Injecting KobeAI autoinstall profiles + payload"
mkdir -p "$EXTRACT/autoinstall" "$EXTRACT/payload"
rsync -a --delete "$HERE/autoinstall/" "$EXTRACT/autoinstall/"
rsync -a --delete "$HERE/payload/"     "$EXTRACT/payload/"
chmod +x "$EXTRACT/payload/firstboot.sh" \
         "$EXTRACT/payload/master/install-master.sh" \
         "$EXTRACT/payload/worker/install-worker.sh"
ok "Injected"

# -----------------------------------------------------------------------------
# 6. Replace the GRUB menu (BIOS + UEFI use the same grub.cfg on the live ISO)
# -----------------------------------------------------------------------------
step "Replacing GRUB boot menu"
cp "$HERE/grub/grub.cfg" "$EXTRACT/boot/grub/grub.cfg"
# Some Ubuntu builds also have a second copy under /EFI/boot/
if [[ -f "$EXTRACT/EFI/boot/grub.cfg" ]]; then
  cp "$HERE/grub/grub.cfg" "$EXTRACT/EFI/boot/grub.cfg"
fi
ok "Boot menu installed"

# -----------------------------------------------------------------------------
# 7. Repack as a hybrid (BIOS + UEFI) bootable ISO
#    Uses xorriso's "indev/outdev" replay pattern so the El Torito + UEFI
#    partition layout from the original Ubuntu ISO is preserved exactly.
# -----------------------------------------------------------------------------
step "Repacking ISO as $FINAL_ISO"
rm -f "$FINAL_ISO"
xorriso -as mkisofs \
  -r -V "KOBEAI_INSTALLER" \
  -J -joliet-long \
  -iso-level 3 \
  -partition_offset 16 \
  --grub2-mbr "$EXTRACT/boot/grub/i386-pc/boot_hybrid.img" \
  --mbr-force-bootable \
  -append_partition 2 0xEF "$EXTRACT/boot/grub/efi.img" \
  -appended_part_as_gpt \
  -c '/boot.catalog' \
  -b '/boot/grub/i386-pc/eltorito.img' \
    -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
  -eltorito-alt-boot \
  -e '--interval:appended_partition_2:::' \
    -no-emul-boot \
  -o "$FINAL_ISO" \
  "$EXTRACT" \
  || die "xorriso failed — see output above"

ok "Built $FINAL_ISO ($(du -h "$FINAL_ISO" | cut -f1))"

# -----------------------------------------------------------------------------
# 8. Done
# -----------------------------------------------------------------------------
cat <<EOF

${BOLD}${GREEN}================================================================${NC}
${BOLD}${GREEN}  KobeAI installer ISO built successfully${NC}
${BOLD}${GREEN}================================================================${NC}

  Output:  $FINAL_ISO

  Next steps:
    1. Plug in a 16 GB+ USB stick.
    2. Use Balena Etcher (https://etcher.balena.io) or run:
         sudo dd if=$FINAL_ISO of=/dev/sdX bs=4M status=progress conv=fsync
       …replacing /dev/sdX with your USB device.
    3. Boot the target machine from the USB.
    4. At the boot menu pick:
         "Install KobeAI MASTER" on the Lenovo laptop
         "Install KobeAI WORKER" on the desktop
    5. Walk away for ~20-30 minutes.
    6. After the first reboot, log in and read /root/kobeai-credentials.txt
       on the master for the super-admin password.

EOF
