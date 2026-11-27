#!/usr/bin/env bash
# state-migrate.sh — one-time migration for installs that tracked device state.
#
# Before this change, settings.json, pi-cron.tab and AGENTS.{user,dev}.md were
# versioned, so a git reset or a pull could revert them. This script:
#   1. backs up the four live files,
#   2. discards their tracked changes (they become ignored),
#   3. pulls the new main (which removes them from the index),
#   4. restores the backed-up files and fills any missing one from templates.
#
# Usage:
#   bash ~/pi-system/scripts/state-migrate.sh            # dry run
#   bash ~/pi-system/scripts/state-migrate.sh --apply    # do it
#
# The backup is kept at ~/.pi/agent/state-backup-<timestamp>/ on success too.

set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

HOME_DIR="${PI_HOME:-$HOME}"
ROOT="$HOME_DIR"
FILES=(
  ".pi/agent/settings.json"
  ".pi/agent/pi-cron.tab"
  "workspace/AGENTS.user.md"
  "workspace/AGENTS.dev.md"
)

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME_DIR/.pi/agent/state-backup-$TS"

say() { printf '\n==> %s\n' "$*"; }
run() {
  if $APPLY; then
    echo "  \$ $*"
    eval "$@"
  else
    echo "  (dry) $*"
  fi
}

say "Checking repository"
[[ -d "$ROOT/.git" ]] || { echo "not a git checkout: $ROOT" >&2; exit 1; }
echo "  repo: $ROOT ($(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"

say "Backing up device state to $BACKUP"
run "mkdir -p '$BACKUP'"
for f in "${FILES[@]}"; do
  if [[ -f "$ROOT/$f" ]]; then
    run "mkdir -p '$BACKUP/$(dirname "$f")'"
    run "cp '$ROOT/$f' '$BACKUP/$f'"
  else
    echo "  (skip) $f not present"
  fi
done

say "Discarding tracked changes on device state"
for f in "${FILES[@]}"; do
  if git -C "$ROOT" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    run "git -C '$ROOT' checkout -- '$f'"
  else
    echo "  (skip) $f is not tracked anymore"
  fi
done

say "Pulling latest main"
run "git -C '$ROOT' pull --ff-only --no-rebase"

say "Restoring device state"
for f in "${FILES[@]}"; do
  if [[ -f "$BACKUP/$f" ]]; then
    run "mkdir -p '$ROOT/$(dirname "$f")'"
    run "cp '$BACKUP/$f' '$ROOT/$f'"
  fi
done

say "Filling missing files from templates"
run "bash '$ROOT/pi-system/scripts/state-init.sh'"

if $APPLY; then
  printf '\nDone. Backup kept at %s\n' "$BACKUP"
else
  printf '\nDry run complete. Re-run with --apply.\n'
fi
