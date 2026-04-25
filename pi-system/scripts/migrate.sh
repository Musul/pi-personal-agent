#!/bin/bash
# migrate.sh — one-shot migration on the Termux device
#
# Replays the workspace → pi-system restructure.
# Safe to re-run: every step is idempotent and checks state before touching anything.
#
# Usage on the Android device (Termux):
#   bash ~/pi-system/scripts/migrate.sh           # dry run summary
#   bash ~/pi-system/scripts/migrate.sh --apply   # actually move files

set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

HOME_DIR="${PI_HOME:-$HOME}"
WS="$HOME_DIR/workspace"
SYS="$HOME_DIR/pi-system"

run() {
  if $APPLY; then
    echo "  \$ $*"
    eval "$@"
  else
    echo "  (dry) $*"
  fi
}

say() { echo ""; echo "==> $*"; }

say "Checking source state"
for d in "$WS" "$HOME_DIR/.pi/agent"; do
  if [[ ! -d "$d" ]]; then
    echo "  Missing: $d. Aborting." >&2; exit 1
  fi
done
echo "  OK: $WS and ~/.pi/agent exist."

say "Ensuring pi-system/ skeleton"
run "mkdir -p $SYS/extensions/{pi-channel-telegram,pi-tool-tavily,pi-tool-elevenlabs,pi-tool-archive,pi-tool-parse-document,pi-tool-finanzas,pi-tool-backup,pi-provider-kimi,pi-cron-forked,_archive}"
run "mkdir -p $SYS/logs/{cron,sessions/archives,sessions/raw,backups,system}"
run "mkdir -p $SYS/docs/{extensions,developer}"
run "mkdir -p $SYS/scripts"

# ─── Move workspace content into pi-system if present ─────────────────
move_if_exists() {
  local src="$1" dst="$2"
  if [[ -e "$src" ]]; then
    run "mkdir -p $(dirname "$dst")"
    run "mv '$src' '$dst'"
  else
    echo "  (skip) $src not present"
  fi
}

say "Moving pi-telebridge-fork → pi-channel-telegram"
if [[ -d "$WS/pi-telebridge-fork" ]]; then
  run "mv $WS/pi-telebridge-fork/src           $SYS/extensions/pi-channel-telegram/src"
  run "mv $WS/pi-telebridge-fork/package.json  $SYS/extensions/pi-channel-telegram/package.json"
  run "mv $WS/pi-telebridge-fork/package-lock.json $SYS/extensions/pi-channel-telegram/package-lock.json 2>/dev/null || true"
  run "mv $WS/pi-telebridge-fork/README.md     $SYS/extensions/pi-channel-telegram/README.md 2>/dev/null || true"
  run "mv $WS/pi-telebridge-fork/CHANGES.md    $SYS/extensions/pi-channel-telegram/CHANGES.md 2>/dev/null || true"
  run "rmdir $WS/pi-telebridge-fork 2>/dev/null || true"
fi

say "Moving pi-doc-tools → pi-tool-parse-document"
if [[ -d "$WS/scripts/pi-doc-tools" ]]; then
  run "mv $WS/scripts/pi-doc-tools/src          $SYS/extensions/pi-tool-parse-document/src"
  run "mv $WS/scripts/pi-doc-tools/package.json $SYS/extensions/pi-tool-parse-document/package.json"
  run "mv $WS/scripts/pi-doc-tools/package-lock.json $SYS/extensions/pi-tool-parse-document/package-lock.json 2>/dev/null || true"
  run "mv $WS/scripts/pi-doc-tools/config.json  $SYS/extensions/pi-tool-parse-document/config.json 2>/dev/null || true"
  run "mv $WS/scripts/pi-doc-tools/README.md    $SYS/extensions/pi-tool-parse-document/README.md 2>/dev/null || true"
  run "rmdir $WS/scripts/pi-doc-tools 2>/dev/null || true"
fi

say "Moving individual scripts into their new extensions"
move_if_exists "$WS/scripts/tavily.js"            "$SYS/extensions/pi-tool-tavily/tavily.js"
move_if_exists "$WS/scripts/elevenlabs.js"        "$SYS/extensions/pi-tool-elevenlabs/elevenlabs.js"
move_if_exists "$WS/scripts/send-telegram-voice.js" "$SYS/extensions/pi-tool-elevenlabs/send-telegram-voice.js"
move_if_exists "$WS/scripts/archive-session.js"   "$SYS/extensions/pi-tool-archive/archive-session.js"
move_if_exists "$WS/scripts/pi-backup.sh"         "$SYS/extensions/pi-tool-backup/pi-backup.sh"
move_if_exists "$WS/finanzas/finanzas.js"         "$SYS/extensions/pi-tool-finanzas/finanzas.js"
move_if_exists "$WS/finanzas/inversiones/inversiones.js" "$SYS/extensions/pi-tool-finanzas/inversiones.js"

[[ -d "$WS/scripts" ]] && run "rmdir $WS/scripts 2>/dev/null || true"

say "Rotating logs into pi-system/logs"
if [[ -d "$WS/cron-logs" ]]; then
  run "mv $WS/cron-logs/* $SYS/logs/cron/ 2>/dev/null || true"
  run "rmdir $WS/cron-logs 2>/dev/null || true"
fi
if [[ -d "$WS/backups" ]]; then
  run "mv $WS/backups/* $SYS/logs/backups/ 2>/dev/null || true"
  run "rmdir $WS/backups 2>/dev/null || true"
fi
if [[ -d "$WS/pi-telebridge" && ! -d "$SYS/extensions/_archive/pi-telebridge-original" ]]; then
  run "mv $WS/pi-telebridge $SYS/extensions/_archive/pi-telebridge-original"
fi

# ─── Forks: kimicodeprovider, @e9n/pi-cron ──────────────────────────────
say "Forking kimicodeprovider → pi-provider-kimi"
KIMI_SRC="/data/data/com.termux/files/usr/lib/node_modules/kimicodeprovider"
if [[ -d "$KIMI_SRC" && ! -f "$SYS/extensions/pi-provider-kimi/package.json" ]]; then
  run "cp -r $KIMI_SRC/* $SYS/extensions/pi-provider-kimi/"
  if $APPLY; then
    node -e "const f='$SYS/extensions/pi-provider-kimi/package.json'; const p=require(f); p.name='pi-provider-kimi'; p.version=(p.version||'0.0.0')+'-fork'; require('fs').writeFileSync(f, JSON.stringify(p,null,2));"
    (cd "$SYS/extensions/pi-provider-kimi" && npm install --omit=dev --no-audit --no-fund) || echo "  (npm install failed, continue manually)"
  fi
else
  echo "  (skip) fork already populated or upstream not found"
fi

say "Forking @e9n/pi-cron → pi-cron-forked"
CRON_SRC="/data/data/com.termux/files/usr/lib/node_modules/@e9n/pi-cron"
if [[ -d "$CRON_SRC" && ! -f "$SYS/extensions/pi-cron-forked/package.json" ]]; then
  run "cp -r $CRON_SRC/* $SYS/extensions/pi-cron-forked/"
  if $APPLY; then
    node -e "const f='$SYS/extensions/pi-cron-forked/package.json'; const p=require(f); p.name='pi-cron-forked'; p.version=(p.version||'0.0.0')+'-fork'; require('fs').writeFileSync(f, JSON.stringify(p,null,2));"
    (cd "$SYS/extensions/pi-cron-forked" && npm install --omit=dev --no-audit --no-fund) || echo "  (npm install failed, continue manually)"
  fi
else
  echo "  (skip) fork already populated or upstream not found"
fi

# ─── AGENTS.md symlink ─────────────────────────────────────────────────
say "Setting up AGENTS.md symlink (default: dev)"
if [[ -f "$WS/AGENTS.user.md" && -f "$WS/AGENTS.dev.md" ]]; then
  if [[ -f "$WS/AGENTS.md" && ! -L "$WS/AGENTS.md" ]]; then
    run "mv $WS/AGENTS.md $WS/AGENTS.md.pre-migration.bak"
  fi
  run "ln -sfn AGENTS.dev.md $WS/AGENTS.md"
else
  echo "  (skip) AGENTS.user.md or AGENTS.dev.md missing — create them first"
fi

# ─── Apply dev mode by default so the owner can finish setup ───────────
say "Switching to dev mode"
if [[ -x "$SYS/scripts/set-mode.sh" ]]; then
  run "bash $SYS/scripts/set-mode.sh dev"
else
  echo "  (skip) set-mode.sh missing or not executable. chmod +x then run manually."
fi

# ─── Regenerate DEPENDENCIES.md ────────────────────────────────────────
say "Regenerating DEPENDENCIES.md"
if [[ -f "$SYS/scripts/gen-deps-map.js" ]]; then
  run "node $SYS/scripts/gen-deps-map.js"
fi

# ─── Install extension deps (opt) ──────────────────────────────────────
say "Installing node_modules for extensions that have package.json"
if $APPLY; then
  for d in "$SYS"/extensions/*/; do
    if [[ -f "$d/package.json" ]]; then
      echo "  npm install in $d"
      (cd "$d" && npm install --omit=dev --no-audit --no-fund) || echo "    (failed, continue)"
    fi
  done
else
  for d in "$SYS"/extensions/*/; do
    [[ -f "$d/package.json" ]] && echo "  (dry) npm install in $d"
  done
fi

# ─── Final sanity ──────────────────────────────────────────────────────
say "Final sanity"
echo "  ls $SYS/extensions:"
ls -1 "$SYS/extensions" 2>/dev/null || true
echo "  AGENTS.md → $(readlink "$WS/AGENTS.md" 2>/dev/null || echo 'not a symlink')"
echo "  Current mode: $(cat "$SYS/.mode" 2>/dev/null || echo 'unset')"

if ! $APPLY; then
  echo ""
  echo "Dry run complete. Re-run with --apply to execute."
fi

echo ""
echo "Post-migration checklist:"
echo "  1. Verify ~/.pi/agent/settings.json paths are correct."
echo "  2. bash $SYS/extensions/pi-tool-backup/pi-backup.sh --transfer --no-send"
echo "     (confirm archive size is reasonable and node_modules excluded)"
echo "  3. pi  (start pi-mono and confirm all extensions load)"
echo "  4. When cliente-ready: bash $SYS/scripts/set-mode.sh user"
