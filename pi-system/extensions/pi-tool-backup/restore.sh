#!/bin/bash
# restore.sh — restore a pi-backup bundle
#
# Usage:
#   bash restore.sh <backup.tar.gz> [--target <dir>] [--install-deps]
#
# Steps:
#   1. Extract the archive into target dir (default: $HOME).
#   2. Read registry.json + manifest to know which extensions need node_modules.
#   3. If --install-deps, run `npm install` inside each extension that has package.json.
#   4. Print next-step instructions (forks, env vars, pi install).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.tar.gz> [--target <dir>] [--install-deps]" >&2
  exit 2
fi

ARCHIVE="$1"; shift
TARGET="$HOME"
INSTALL_DEPS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)       TARGET="$2"; shift 2 ;;
    --install-deps) INSTALL_DEPS=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

mkdir -p "$TARGET"
echo "Extracting $ARCHIVE into $TARGET ..."
tar -xzf "$ARCHIVE" -C "$TARGET"

REG="$TARGET/pi-system/registry.json"
if [[ ! -f "$REG" ]]; then
  echo "Warning: $REG not found. Archive may be incomplete." >&2
fi

if [[ "$INSTALL_DEPS" == "true" ]]; then
  EXT_DIR="$TARGET/pi-system/extensions"
  if [[ -d "$EXT_DIR" ]]; then
    for dir in "$EXT_DIR"/*/; do
      if [[ -f "$dir/package.json" ]]; then
        echo "Installing deps for: $dir"
        (cd "$dir" && npm install --omit=dev --no-audit --no-fund || echo "  (install failed, continuing)")
      fi
    done
  fi
fi

echo ""
echo "Restore complete."
echo ""
echo "Next steps:"
echo "  1. Review ~/.env and export any required API keys"
echo "     (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TAVILY_API_KEY, ELEVENLABS_API_KEY, etc.)"
echo "  2. If ~/pi-system/extensions/pi-provider-kimi or pi-cron-forked are missing their sources,"
echo "     refer to each README to re-fork from the upstream package."
echo "  3. Run: pi  (harness will read ~/.pi/agent/settings.json and load extensions)"
echo "  4. Inside pi, run: /telegram setup   (if chat id changed on new device)"
echo "  5. Pick mode: bash ~/pi-system/scripts/set-mode.sh user|dev"
