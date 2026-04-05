#!/usr/bin/env bash
set -euo pipefail

# Build the omni-sandbox binary for the current platform and copy it to assets/bin/.
# Usage:
#   ./scripts/build-sandbox.sh              # Build for current platform
#   ./scripts/build-sandbox.sh --target x86_64-pc-windows-gnu   # Cross-compile

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SANDBOX_DIR="$PROJECT_ROOT/sandbox-cli"
BIN_DIR="$PROJECT_ROOT/assets/bin"

TARGET=""
if [[ "${1:-}" == "--target" && -n "${2:-}" ]]; then
  TARGET="$2"
fi

echo "Building omni-sandbox..."

cd "$SANDBOX_DIR"

if [[ -n "$TARGET" ]]; then
  cargo build --release --target "$TARGET"
  RELEASE_DIR="target/$TARGET/release"
else
  cargo build --release
  RELEASE_DIR="target/release"
fi

mkdir -p "$BIN_DIR"

# Determine binary name based on target or current OS.
case "${TARGET:-$(uname -s)}" in
  *windows*|*Windows*|MINGW*|CYGWIN*)
    BIN_NAME="omni-sandbox.exe"
    ;;
  *)
    BIN_NAME="omni-sandbox"
    ;;
esac

cp "$RELEASE_DIR/$BIN_NAME" "$BIN_DIR/$BIN_NAME"
echo "Copied $BIN_NAME to assets/bin/"

# On Linux, also bundle a static bwrap binary if available.
if [[ "$(uname -s)" == "Linux" && -z "$TARGET" ]]; then
  BWRAP_PATH="$(command -v bwrap 2>/dev/null || true)"
  if [[ -n "$BWRAP_PATH" ]]; then
    cp "$BWRAP_PATH" "$BIN_DIR/bwrap"
    echo "Copied bwrap to assets/bin/"
  else
    echo "WARNING: bwrap not found on PATH. Linux builds will require system-installed bubblewrap."
  fi
fi

ls -lh "$BIN_DIR"/omni-sandbox* "$BIN_DIR"/bwrap 2>/dev/null || true
echo "Done."
