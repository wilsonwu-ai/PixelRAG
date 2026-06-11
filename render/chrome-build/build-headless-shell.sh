#!/usr/bin/env bash
# Build the patched headless_shell for pixelshot's turbo capture path.
# Host build: produces a binary for whatever OS/arch you run this on
# (Linux, macOS, or Windows-via-Git-Bash). See BUILD.md for prerequisites.
#
# Usage:
#   CHROMIUM_DIR=/path/to/chromium ./build-headless-shell.sh
# Expects $CHROMIUM_DIR/src to be a Chromium checkout at the base in BUILD.md,
# with depot_tools on PATH and ~100 GB free disk.
set -euo pipefail

CHROMIUM_DIR="${CHROMIUM_DIR:?set CHROMIUM_DIR to your chromium checkout (contains src/)}"
PATCH="$(cd "$(dirname "$0")" && pwd)/pixelrag-chrome.patch"
OUT="${OUT:-out/Headless}"
SRC="$CHROMIUM_DIR/src"

command -v gn >/dev/null      || { echo "depot_tools not on PATH (gn missing)"; exit 1; }
command -v autoninja >/dev/null || { echo "depot_tools not on PATH (autoninja missing)"; exit 1; }
[ -f "$SRC/chrome/VERSION" ]  || { echo "no Chromium checkout at $SRC"; exit 1; }

echo "[build] machine: $(uname -s) $(uname -m), cpus: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')"
echo "[build] chromium: $(grep -h MAJOR "$SRC/chrome/VERSION" | head -1)"

cd "$CHROMIUM_DIR"
gclient sync --with_branch_heads --with_tags --delete_unversioned_trees -j 32
gclient runhooks

cd "$SRC"
# Apply the patch only if not already applied (idempotent).
if git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "[build] patch already applied"
else
    echo "[build] applying $PATCH"
    git apply "$PATCH"
fi

mkdir -p "$OUT"
cat > "$OUT/args.gn" <<'EOF'
import("//build/args/headless.gn")
is_official_build = true
is_debug = false
symbol_level = 0
blink_symbol_level = 0
chrome_pgo_phase = 0
EOF

gn gen "$OUT"
time autoninja -C "$OUT" headless_shell

echo "[build] done: $SRC/$OUT/headless_shell"
ls -lh "$SRC/$OUT/headless_shell"*
echo "[build] macOS: codesign + notarize before distributing (Gatekeeper)."
