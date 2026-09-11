#!/usr/bin/env bash
# Produces a single-file kobeai-demo(.exe) using Node's Single Executable
# Applications feature (stable since Node 22).
#
# Cross-compilation isn't supported — run this on the target OS.
#
#   Linux   → dist/kobeai-demo
#   macOS   → dist/kobeai-demo
#   Windows → dist\kobeai-demo.exe  (run this script from Git Bash / WSL,
#                                    or translate the commands to PowerShell)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "kobeai-demo pack requires Node 22 or later (found $(node -v))" >&2
  exit 1
fi

echo "[pack-exe] step 1 — esbuild bundle"
node ./build.mjs

echo "[pack-exe] step 2 — build the SEA blob"
mkdir -p dist
cat > dist/sea-config.json <<JSON
{
  "main": "kobeai-demo.mjs",
  "output": "kobeai-demo.blob",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": true
}
JSON

(cd dist && node --experimental-sea-config sea-config.json)

echo "[pack-exe] step 3 — copy the node binary and inject the blob"
OS="$(uname -s 2>/dev/null || echo Windows_NT)"
case "$OS" in
  Linux)     OUT="dist/kobeai-demo" ;;
  Darwin)    OUT="dist/kobeai-demo" ;;
  MINGW*|CYGWIN*|MSYS*|Windows_NT) OUT="dist/kobeai-demo.exe" ;;
  *)         OUT="dist/kobeai-demo" ;;
esac

cp "$(command -v node)" "$OUT"

# macOS: strip the codesign signature so postject can rewrite the binary;
# postject will let the caller re-sign afterwards.
if [ "$OS" = "Darwin" ]; then
  codesign --remove-signature "$OUT" || true
fi

echo "[pack-exe] step 4 — inject the blob via postject"
npx --yes postject "$OUT" NODE_SEA_BLOB dist/kobeai-demo.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  $([ "$OS" = "Darwin" ] && echo "--macho-segment-name NODE_SEA")

if [ "$OS" = "Darwin" ]; then
  codesign --sign - "$OUT" || true
fi

echo ""
echo "kobeai-demo built at $OUT"
echo ""
echo "Run it:   DATABASE_URL=postgres://postgres:demo@127.0.0.1:5433/postgres $OUT"
echo "Docker DB: docker run --rm -e POSTGRES_PASSWORD=demo -p 5433:5432 postgres:16"
