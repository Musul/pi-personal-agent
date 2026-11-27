#!/usr/bin/env bash
# state-init.sh — create device-local state files from their templates.
#
# Device-local state is intentionally NOT versioned: git reset/checkout/clean
# on ~ must never revert settings, cron jobs or the persona. The repo ships
# templates; this script copies a template to its live path only when the
# live file is missing. It never overwrites existing state.
#
# Safe to re-run. Used by migrate.sh (fresh install) and pi-update.sh.

set -euo pipefail

HOME_DIR="${PI_HOME:-$HOME}"

PAIRS=(
  ".pi/agent/settings.template.json:.pi/agent/settings.json"
  ".pi/agent/pi-cron.template.tab:.pi/agent/pi-cron.tab"
  "workspace/AGENTS.user.template.md:workspace/AGENTS.user.md"
  "workspace/AGENTS.dev.template.md:workspace/AGENTS.dev.md"
)

created=0
for pair in "${PAIRS[@]}"; do
  src="${pair%%:*}"
  dst="${pair#*:}"
  src_path="$HOME_DIR/$src"
  dst_path="$HOME_DIR/$dst"

  if [[ -e "$dst_path" ]]; then
    continue
  fi
  if [[ ! -f "$src_path" ]]; then
    echo "  ! missing template: $src" >&2
    continue
  fi
  mkdir -p "$(dirname "$dst_path")"
  cp "$src_path" "$dst_path"
  echo "  created $dst"
  created=$((created + 1))
done

if (( created == 0 )); then
  echo "  device state: all live files present"
fi
