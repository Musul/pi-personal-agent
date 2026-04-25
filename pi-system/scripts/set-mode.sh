#!/bin/bash
# set-mode.sh — switch agent between user and developer mode
#
# Usage:
#   set-mode.sh user    # freeze pi-system/{extensions,docs,scripts}, symlink AGENTS.md → AGENTS.user.md
#   set-mode.sh dev     # unfreeze, symlink AGENTS.md → AGENTS.dev.md
#   set-mode.sh status  # print current mode
#
# The agent never calls this — only the human owner does.
# In user mode, writes to pi-system/ fail at the filesystem level (chmod a-w),
# so a misbehaving LLM cannot modify extensions or documentation.

set -euo pipefail

HOME_DIR="${PI_HOME:-$HOME}"
WORKSPACE="$HOME_DIR/workspace"
SYSTEM="$HOME_DIR/pi-system"
FROZEN_DIRS=("$SYSTEM/extensions" "$SYSTEM/docs" "$SYSTEM/scripts")
MODE_FILE="$SYSTEM/.mode"
AGENTS_LINK="$WORKSPACE/AGENTS.md"
AGENTS_USER="$WORKSPACE/AGENTS.user.md"
AGENTS_DEV="$WORKSPACE/AGENTS.dev.md"

print_status() {
  local current="unknown"
  [[ -f "$MODE_FILE" ]] && current="$(cat "$MODE_FILE")"
  echo "Current mode: $current"
  if [[ -L "$AGENTS_LINK" ]]; then
    echo "AGENTS.md -> $(readlink "$AGENTS_LINK")"
  elif [[ -f "$AGENTS_LINK" ]]; then
    echo "AGENTS.md is a regular file (not a symlink)"
  else
    echo "AGENTS.md missing"
  fi
}

case "${1:-}" in
  user)
    [[ -f "$AGENTS_USER" ]] || { echo "Missing $AGENTS_USER" >&2; exit 1; }
    ln -sfn "AGENTS.user.md" "$AGENTS_LINK"
    for d in "${FROZEN_DIRS[@]}"; do
      [[ -d "$d" ]] && chmod -R a-w "$d" || true
    done
    echo "user" >"$MODE_FILE"
    echo "Mode → user. pi-system/ is read-only. AGENTS.md → AGENTS.user.md."
    ;;
  dev)
    [[ -f "$AGENTS_DEV" ]] || { echo "Missing $AGENTS_DEV" >&2; exit 1; }
    ln -sfn "AGENTS.dev.md" "$AGENTS_LINK"
    for d in "${FROZEN_DIRS[@]}"; do
      [[ -d "$d" ]] && chmod -R u+w "$d" || true
    done
    echo "dev" >"$MODE_FILE"
    echo "Mode → dev. pi-system/ is writable. AGENTS.md → AGENTS.dev.md."
    ;;
  status|"")
    print_status
    ;;
  *)
    echo "Usage: $0 user|dev|status" >&2
    exit 2
    ;;
esac
