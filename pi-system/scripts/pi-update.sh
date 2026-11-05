#!/usr/bin/env bash
# pi-update.sh - universal updater for the Pi personal agent.
#
# Updates, in order:
#   1. the pi-personal-agent git checkout (autostashing local tracked changes)
#   2. the pi CLI itself (npm, with Termux shebang repair)
#   3. dependencies of the local extensions in ~/pi-system/extensions
#   4. the model catalog (OpenCode Go / Zen models included)
#
# Safe on Termux. Works on generic Linux and macOS too.
#
# Usage:
#   pi-update                     # full update
#   pi-update --check             # show what would change, write nothing
#   pi-update --self              # pi CLI only
#   pi-update --models            # model catalog only
#   pi-update --yes               # non-interactive
#   pi-update --version 1.5.0     # pin a pi version
#   pi-update --rollback          # reinstall the version recorded before the last update
#
# Options:
#   --self / --no-self            enable/disable pi CLI update
#   --repo / --no-repo            enable/disable git checkout update
#   --extensions / --no-extensions
#   --models / --no-models
#   --all                         same as the default (all four)
#   --autostash / --no-autostash  preserve local tracked changes around git pull (default: autostash)
#   --channel auto|latest|legacy  auto picks legacy-node20 when Node < 22.19
#   --version <x.y.z>             pin pi version
#   --force                       reinstall even when already up to date
#   --no-mode-switch              fail instead of temporarily unlocking user mode
#   --json                        print a machine-readable summary at the end
#   -h, --help
#
# Exit codes: 0 success, 1 failure, 2 usage error.
#
# This script is intentionally dependency-light: bash, node, npm, git, curl.
# It never edits secrets and never uninstalls packages automatically.

set -euo pipefail

SELF_PATH="${BASH_SOURCE[0]}"
# Follow symlinks (e.g. $PREFIX/bin/pi-update -> ~/pi-system/scripts/pi-update.sh)
# so SYS_DIR is the agent system, not the bin directory.
SELF_REAL="$(readlink -f "$SELF_PATH" 2>/dev/null || printf '%s' "$SELF_PATH")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SELF_REAL")" && pwd -P)"
SYS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
HOME_DIR="${PI_HOME:-$HOME}"
AGENT_DIR="$HOME_DIR/.pi/agent"
STATE_FILE="$AGENT_DIR/pi-update-state.json"
LOG_DIR="$SYS_DIR/logs/system"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/pi-update-$TS.log"

PI_PKG="@earendil-works/pi-coding-agent"
OLD_PI_PKG="@mariozechner/pi-coding-agent"

DO_SELF=1
DO_REPO=1
DO_EXT=1
DO_MODELS=1
DRY=0
ASSUME_YES=0
FORCE=0
MODE_SWITCH=1
AUTOSTASH=1
JSON=0
ROLLBACK=0
CHANNEL="auto"
PIN=""
TAG="latest"

ORIGINAL_MODE=""
REPO_ROOT=""
REPO_BEFORE=""
REPO_BEFORE_FULL=""
REPO_AFTER=""
REPO_FAILED=0
OLD_VERSION=""
OLD_PACKAGE=""
NEW_VERSION=""
STATUS="ok"
SUMMARY=()

say()  { printf '\n==> %s\n' "$*"; }
log()  { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; STATUS="error"; exit 1; }

usage() {
  sed -n '2,39p' "$SELF_REAL" | sed 's/^# \{0,1\}//'
}

# ── Output / logging ────────────────────────────────────────────────────
# Logging is set up after argument parsing so --check stays read-only.

# ── Mode handling ───────────────────────────────────────────────────────
restore_mode() {
  local rc=$?
  trap - EXIT
  if [[ -n "$ORIGINAL_MODE" && "$ORIGINAL_MODE" != "unknown" ]]; then
    log "Restoring $ORIGINAL_MODE mode..."
    bash "$SYS_DIR/scripts/set-mode.sh" "$ORIGINAL_MODE" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap restore_mode EXIT

current_mode() {
  local m="unknown"
  [[ -f "$SYS_DIR/.mode" ]] && m="$(cat "$SYS_DIR/.mode" 2>/dev/null || echo unknown)"
  printf '%s' "$m"
}

ensure_writable_mode() {
  local mode
  mode="$(current_mode)"
  [[ "$mode" == "user" ]] || return 0
  if (( ! MODE_SWITCH )); then
    die "User mode is active and --no-mode-switch was given. Run: bash $SYS_DIR/scripts/set-mode.sh dev"
  fi
  if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
    printf '\nUser mode is active (pi-system is read-only).\n'
    printf 'Temporarily switch to dev mode to update, then restore user mode? [y/N] '
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "Update cancelled."
  elif (( ! ASSUME_YES )); then
    die "User mode is active. Re-run with --yes (it will be restored automatically)."
  fi
  [[ -f "$SYS_DIR/scripts/set-mode.sh" ]] || die "Missing $SYS_DIR/scripts/set-mode.sh; cannot unlock user mode."
  ORIGINAL_MODE="$mode"
  log "Temporarily switching to dev mode..."
  bash "$SYS_DIR/scripts/set-mode.sh" dev >/dev/null
}

# ── Args ────────────────────────────────────────────────────────────────
while (( $# )); do
  case "$1" in
    --check|--dry-run) DRY=1 ;;
    --yes|-y)          ASSUME_YES=1 ;;
    --force)           FORCE=1 ;;
    --json)            JSON=1 ;;
    --rollback)        ROLLBACK=1 ;;
    --self)            DO_SELF=1; DO_REPO=0; DO_EXT=0; DO_MODELS=0 ;;
    --no-self)         DO_SELF=0 ;;
    --repo)            DO_SELF=0; DO_REPO=1; DO_EXT=0; DO_MODELS=0 ;;
    --no-repo)         DO_REPO=0 ;;
    --extensions|--ext) DO_SELF=0; DO_REPO=0; DO_EXT=1; DO_MODELS=0 ;;
    --no-extensions|--no-ext) DO_EXT=0 ;;
    --models)          DO_MODELS=1; DO_SELF=0; DO_REPO=0; DO_EXT=0 ;;
    --no-models)       DO_MODELS=0 ;;
    --all)             DO_SELF=1; DO_REPO=1; DO_EXT=1; DO_MODELS=1 ;;
    --autostash)       AUTOSTASH=1 ;;
    --no-autostash)    AUTOSTASH=0 ;;
    --channel)         CHANNEL="${2:-}"; shift; [[ -n "$CHANNEL" ]] || die "--channel needs a value" ;;
    --version)         PIN="${2:-}"; shift; [[ -n "$PIN" ]] || die "--version needs a value" ;;
    --no-mode-switch)  MODE_SWITCH=0 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

case "$CHANNEL" in auto|latest|legacy) ;; *) die "Invalid --channel: $CHANNEL (use auto, latest or legacy)" ;; esac

# ── Logging (skip for --check so it stays read-only) ────────────────────
if (( JSON )); then
  # Keep stdout clean for the final JSON. fd 3 points at the real stdout.
  exec 3>&1
fi

if (( ! DRY )) && mkdir -p "$LOG_DIR" 2>/dev/null && [[ -w "$LOG_DIR" ]]; then
  if (( JSON )); then
    exec 1> >(tee -a "$LOG_FILE" >&2) 2>&1
  else
    exec > >(tee -a "$LOG_FILE") 2>&1
  fi
else
  LOG_FILE=""
  if (( JSON )); then
    exec 1>&2
  fi
fi

# Make the universal command available after the first real run on Termux.
if (( ! DRY )) && [[ "${PREFIX:-}" == *com.termux* && -d "$PREFIX/bin" ]]; then
  chmod +x "$SCRIPT_DIR/$(basename "$SELF_REAL")" 2>/dev/null || true
  ln -sfn "$SCRIPT_DIR/$(basename "$SELF_REAL")" "$PREFIX/bin/pi-update" 2>/dev/null || true
fi

# ── Helpers ─────────────────────────────────────────────────────────────
run() {
  if (( DRY )); then
    log "(check) $*"
    return 0
  fi
  log "$ $*"
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

fix_termux_shebang() {
  have pkg || return 0
  [[ "${PREFIX:-}" == *com.termux* ]] || return 0
  local bin real
  bin="$(command -v pi || true)"
  [[ -n "$bin" ]] || return 0
  if ! have termux-fix-shebang; then
    log "$ pkg install -y termux-tools"
    pkg install -y termux-tools >/dev/null 2>&1 || true
  fi
  if ! have termux-fix-shebang; then
    warn "termux-fix-shebang is missing. Run: pkg install termux-tools"
    return 0
  fi
  real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
  log "$ termux-fix-shebang $real"
  termux-fix-shebang "$real" || warn "termux-fix-shebang failed; the widget may not launch pi."
}

node_supports_latest() {
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj > 22 || (maj === 22 && min >= 19) ? 0 : 1);
  ' 2>/dev/null
}

version_cmp() {
  # prints -1, 0 or 1
  node -e '
    const clean = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map(Number);
    const a = clean(process.argv[1]);
    const b = clean(process.argv[2]);
    for (let i = 0; i < 3; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) { console.log(x > y ? 1 : -1); process.exit(0); }
    }
    console.log(0);
  ' "$1" "$2"
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

installed_package() {
  if npm ls -g --depth=0 "$PI_PKG" >/dev/null 2>&1; then
    printf '%s' "$PI_PKG"
  elif npm ls -g --depth=0 "$OLD_PI_PKG" >/dev/null 2>&1; then
    printf '%s' "$OLD_PI_PKG"
  else
    printf '%s' "$PI_PKG"
  fi
}

package_version() {
  local pkg="$1" root
  root="$(npm root -g 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  [[ -f "$root/$pkg/package.json" ]] || return 1
  node -e '
    const fs = require("node:fs");
    process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || "");
  ' "$root/$pkg/package.json" 2>/dev/null
}

find_repo_root() {
  local cand root remote
  for cand in "$HOME_DIR" "$HOME_DIR/pi-personal-agent" "$SYS_DIR" "$SYS_DIR/.."; do
    [[ -d "$cand" ]] || continue
    root="$(git -C "$cand" rev-parse --show-toplevel 2>/dev/null)" || continue
    remote="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      *pi-personal-agent*) printf '%s' "$root"; return 0 ;;
    esac
  done
  return 1
}

write_state() {
  local status="$1"
  (( DRY )) && return 0
  mkdir -p "$AGENT_DIR" 2>/dev/null || true
  node - "$STATE_FILE" "$(date -Iseconds 2>/dev/null || date)" \
    "$OLD_PACKAGE" "$OLD_VERSION" "$PI_PKG" "${NEW_VERSION:-$OLD_VERSION}" \
    "$TAG" "$status" "${LOG_FILE:-}" "$REPO_BEFORE" "$REPO_AFTER" <<'NODE'
const fs = require("node:fs");
const [, , file, lastRun, prevPkg, prevVer, curPkg, curVer, channel, status, log, repoBefore, repoAfter] = process.argv;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const next = {
  last_run: lastRun,
  status,
  previous_package: status === "rollback" && prev.previous_package ? prev.previous_package : prevPkg,
  previous_version: status === "rollback" && prev.previous_version ? prev.previous_version : prevVer,
  current_package: curPkg,
  current_version: curVer,
  channel,
  log: log || undefined,
  repo_before: repoBefore || undefined,
  repo_after: repoAfter || undefined,
};
fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
NODE
}

read_state_field() {
  local field="$1"
  [[ -f "$STATE_FILE" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = s[process.argv[2]];
    if (v === undefined || v === null || v === "") process.exit(1);
    process.stdout.write(String(v));
  ' "$STATE_FILE" "$field" 2>/dev/null
}

# ── Preflight ───────────────────────────────────────────────────────────
say "Preflight"
have node || die "node is not installed. On Termux: pkg install nodejs-lts"
have npm  || die "npm is not installed. On Termux: pkg install nodejs-lts"

NODE_VERSION="$(node -v | sed 's/^v//')"
NPM_VERSION="$(npm -v 2>/dev/null || echo unknown)"
log "node $NODE_VERSION  npm $NPM_VERSION"
log "home: $HOME_DIR"
log "system: $SYS_DIR"
log "mode: $(current_mode)"
[[ -n "$LOG_FILE" ]] && log "log: $LOG_FILE"

if ! node_supports_latest; then
  if [[ "$CHANNEL" == "auto" ]]; then
    CHANNEL="legacy"
    warn "Node $NODE_VERSION is older than 22.19. Using the legacy-node20 pi channel."
  elif [[ "$CHANNEL" == "latest" ]]; then
    die "pi latest requires Node >= 22.19.0 (current: $NODE_VERSION). Upgrade Node or use --channel legacy."
  fi
fi

if [[ "$CHANNEL" == "legacy" ]]; then
  TAG="legacy-node20"
else
  TAG="latest"
fi

if [[ -n "$PIN" ]]; then
  TARGET_SPEC="$PI_PKG@$PIN"
  TARGET_VERSION="$PIN"
else
  TARGET_VERSION="$(npm view "$PI_PKG@$TAG" version 2>/dev/null | tail -n1 || true)"
  if [[ -z "$TARGET_VERSION" ]]; then
    warn "Could not query npm for $PI_PKG@$TAG; skipping the pi CLI version check."
    TARGET_SPEC=""
  else
    TARGET_SPEC="$PI_PKG@$TARGET_VERSION"
  fi
fi

OLD_PACKAGE="$(installed_package)"
OLD_VERSION="$(pi --version 2>/dev/null | head -n1 | tr -d '\r' || true)"
if [[ -z "$OLD_VERSION" ]]; then
  OLD_VERSION="$(package_version "$OLD_PACKAGE" || true)"
fi
[[ -n "$OLD_VERSION" ]] || OLD_VERSION="0.0.0"
log "pi: $OLD_VERSION ($OLD_PACKAGE)"
if [[ -n "$TARGET_VERSION" ]]; then
  VERSION_CMP="$(version_cmp "$OLD_VERSION" "$TARGET_VERSION")"
  if [[ "$VERSION_CMP" == "0" ]] && (( ! FORCE )); then
    log "pi is up to date ($TARGET_VERSION)."
    DO_SELF=0
  elif [[ "$VERSION_CMP" == "1" ]] && (( ! FORCE )); then
    log "current pi ($OLD_VERSION) is newer than $TARGET_VERSION ($TAG); skipping downgrade."
    DO_SELF=0
  else
    log "target pi: $TARGET_VERSION ($TAG)"
  fi
fi

# ── Rollback mode ───────────────────────────────────────────────────────
if (( ROLLBACK )); then
  PREV_VER="$(read_state_field previous_version || true)"
  PREV_PKG="$(read_state_field previous_package || true)"
  [[ -n "$PREV_VER" ]] || die "No previous version recorded in $STATE_FILE"
  PREV_PKG="${PREV_PKG:-$PI_PKG}"
  log "Rolling back to $PREV_PKG@$PREV_VER"
  DO_SELF=1; DO_REPO=0; DO_EXT=0; DO_MODELS=0
  FORCE=1
  PIN="$PREV_VER"
  TARGET_SPEC="$PREV_PKG@$PREV_VER"
  TARGET_VERSION="$PREV_VER"
fi

# ── Repo update ─────────────────────────────────────────────────────────
if (( DO_REPO )); then
  say "Repository"
  if REPO_ROOT="$(find_repo_root)"; then
    REPO_BEFORE="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
    REPO_BEFORE_FULL="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    log "repo: $REPO_ROOT ($REPO_BEFORE)"

    DIRTY=0
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      DIRTY=1
    fi

    if (( DIRTY && ! AUTOSTASH )); then
      warn "Repo has local tracked changes; skipping git pull (--no-autostash)."
      SUMMARY+=("repo: skipped (dirty)")
    elif (( DRY )); then
      if (( DIRTY )); then
        log "(check) local tracked changes; would autostash them and git pull --ff-only"
      else
        log "(check) git -C $REPO_ROOT pull --ff-only --no-rebase"
      fi
    else
      ensure_writable_mode
      if (( DIRTY )); then
        log "Local tracked changes detected; preserving them with autostash."
      fi
      log "$ git -C $REPO_ROOT pull --ff-only --no-rebase --autostash"

      PULL_OK=0
      if git -C "$REPO_ROOT" pull --ff-only --no-rebase --autostash; then
        PULL_OK=1
      fi

      # `git pull --autostash` exits 0 even when reapplying the stash leaves
      # conflicts. Detect that and roll back to the exact pre-pull commit,
      # restoring the local changes. No conflict markers are left behind.
      if [[ -n "$(git -C "$REPO_ROOT" ls-files -u 2>/dev/null)" ]]; then
        warn "Autostash reapplied with conflicts; rolling back to $REPO_BEFORE."
        if [[ -n "$REPO_BEFORE_FULL" ]] \
          && git -C "$REPO_ROOT" reset --hard "$REPO_BEFORE_FULL" >/dev/null 2>&1 \
          && git -C "$REPO_ROOT" stash pop >/dev/null 2>&1; then
          warn "Rolled back cleanly. Local changes are intact; reconcile the overlapping files manually:"
          warn "  bash $SYS_DIR/scripts/set-mode.sh dev"
          warn "  git -C $REPO_ROOT status"
          warn "  git -C $REPO_ROOT diff HEAD origin/main"
          warn "Then run pi-update again."
        else
          warn "Rollback or stash restore failed. Inspect: git -C $REPO_ROOT stash list"
          warn "Switch to dev mode to resolve: bash $SYS_DIR/scripts/set-mode.sh dev"
        fi
        REPO_FAILED=1
        SUMMARY+=("repo: conflict; rolled back")
      elif (( PULL_OK )); then
        REPO_AFTER="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
        if (( DIRTY )); then
          SUMMARY+=("repo: ${REPO_BEFORE:-?} -> ${REPO_AFTER:-?} (local changes preserved)")
        else
          SUMMARY+=("repo: ${REPO_BEFORE:-?} -> ${REPO_AFTER:-?}")
        fi
      else
        warn "git pull failed; continuing with the current checkout."
        REPO_FAILED=1
        SUMMARY+=("repo: pull failed")
      fi
    fi
  else
    log "No pi-personal-agent git checkout detected; skipping."
    SUMMARY+=("repo: not a git checkout")
  fi
fi

# ── Pi CLI update ───────────────────────────────────────────────────────
if (( DO_SELF )); then
  say "Pi CLI"
  if [[ -z "$TARGET_SPEC" ]]; then
    warn "No target version available; skipping pi update."
  elif (( DRY )); then
    log "(check) npm install -g $TARGET_SPEC"
    SUMMARY+=("pi: $OLD_VERSION -> $TARGET_VERSION (check)")
  else
    ensure_writable_mode
    if have pkg && [[ "${PREFIX:-}" == *com.termux* ]]; then
      log "Termux detected."
      log "$ npm install -g --ignore-scripts $TARGET_SPEC"
      if ! npm install -g --ignore-scripts "$TARGET_SPEC"; then
        warn "npm install failed."
        STATUS="error"
      fi
      fix_termux_shebang
    else
      log "$ npm install -g $TARGET_SPEC"
      if ! npm install -g "$TARGET_SPEC"; then
        warn "npm install failed. If this is a permissions error, fix the npm prefix or use sudo."
        STATUS="error"
      fi
    fi

    if [[ "$STATUS" == "ok" ]]; then
      NEW_VERSION="$(pi --version 2>/dev/null | head -n1 | tr -d '\r' || true)"
      if [[ -z "$NEW_VERSION" ]]; then
        warn "pi did not run after the update. Attempting rollback to $OLD_PACKAGE@$OLD_VERSION..."
        if npm install -g "$OLD_PACKAGE@$OLD_VERSION" >/dev/null 2>&1; then
          fix_termux_shebang
          warn "Rollback to $OLD_VERSION succeeded. Check the log."
          STATUS="rollback"
        else
          warn "Rollback failed. Reinstall manually: npm install -g $OLD_PACKAGE@$OLD_VERSION"
          STATUS="error"
        fi
      elif ! pi --list-models >/dev/null 2>&1; then
        warn "pi starts but the model/catalog smoke test failed. Attempting rollback..."
        if npm install -g "$OLD_PACKAGE@$OLD_VERSION" >/dev/null 2>&1; then
          fix_termux_shebang
          warn "Rollback to $OLD_VERSION succeeded. Check the log."
          STATUS="rollback"
          NEW_VERSION="$(pi --version 2>/dev/null | head -n1 | tr -d '\r' || true)"
        else
          warn "Rollback failed. Reinstall manually: npm install -g $OLD_PACKAGE@$OLD_VERSION"
          STATUS="error"
        fi
      else
        log "pi is now $NEW_VERSION"
        SUMMARY+=("pi: $OLD_VERSION -> $NEW_VERSION")
      fi
    fi

    if [[ "$OLD_PACKAGE" == "$OLD_PI_PKG" ]]; then
      log "note: $OLD_PI_PKG is deprecated. The new package is installed and takes precedence."
      log "      Keep the old package installed for now: pi-cron-forked still imports its runtime."
    fi
  fi
fi

# ── Extension dependencies + pi packages ────────────────────────────────
if (( DO_EXT )); then
  say "Extensions"
  EXT_COUNT=0
  EXT_INSTALLED=0
  for dir in "$SYS_DIR"/extensions/*/; do
    [[ -f "$dir/package.json" ]] || continue
    EXT_COUNT=$((EXT_COUNT + 1))
    name="$(basename "$dir")"
    has_deps="$(node -e '
      const fs = require("node:fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const n = Object.keys(p.dependencies || {}).length +
                Object.keys(p.optionalDependencies || {}).length +
                Object.keys(p.peerDependencies || {}).length;
      process.stdout.write(n > 0 ? "1" : "0");
    ' "$dir/package.json" 2>/dev/null || echo 1)"
    if [[ "$has_deps" != "1" ]]; then
      log "$name: no npm dependencies"
      continue
    fi
    marker="$dir/node_modules/.package-lock.json"
    needs_install=0
    [[ -d "$dir/node_modules" ]] || needs_install=1
    [[ -f "$marker" && "$dir/package.json" -nt "$marker" ]] && needs_install=1
    [[ -f "$dir/package-lock.json" && -f "$marker" && "$dir/package-lock.json" -nt "$marker" ]] && needs_install=1
    if (( needs_install )); then
      EXT_INSTALLED=$((EXT_INSTALLED + 1))
      if (( DRY )); then
        log "(check) npm install in extensions/$name"
      else
        ensure_writable_mode
        log "$ npm install in extensions/$name"
        ( cd "$dir" && npm install --omit=dev --no-audit --no-fund ) || warn "npm install failed for $name"
      fi
    else
      log "$name: deps up to date"
    fi
  done
  SUMMARY+=("extensions: $EXT_COUNT found, $EXT_INSTALLED need deps")

  if have pi && pi --help 2>/dev/null | grep -q 'update \[source|self|pi\]'; then
    if (( DRY )); then
      log "(check) pi update --extensions --approve"
    else
      ensure_writable_mode
      log "$ pi update --extensions --approve"
      ( cd "$HOME_DIR" && pi update --extensions --approve ) || warn "pi update --extensions failed (local extensions were handled above)."
    fi
  fi
fi

# ── Model catalog ───────────────────────────────────────────────────────
if (( DO_MODELS )); then
  say "Model catalog"
  if have pi && pi update --help 2>&1 | grep -q -- '--models'; then
    if (( DRY )); then
      log "(check) pi update --models --approve"
    else
      log "$ pi update --models --approve"
      ( cd "$HOME_DIR" && pi update --models --approve ) || warn "pi update --models failed; native model list will be used."
      SUMMARY+=("models: refreshed")
    fi
  else
    log "This pi version has no 'update --models'; model catalogs come with the pi release."
    SUMMARY+=("models: not supported by this pi")
  fi
fi

# ── Final state ─────────────────────────────────────────────────────────
if (( REPO_FAILED )); then
  if [[ "$STATUS" == "ok" || "$STATUS" == "rollback" ]]; then
    STATUS="error"
  fi
  warn "Repository update failed; local changes are preserved in the working tree or stash."
fi

if [[ "$STATUS" == "ok" || "$STATUS" == "rollback" ]] && [[ -n "$NEW_VERSION" ]]; then
  write_state "$STATUS" || warn "Could not write $STATE_FILE (update itself succeeded)."
fi

FINAL_VERSION="$(pi --version 2>/dev/null | head -n1 | tr -d '\r' || echo unknown)"
say "Done"
log "pi: $FINAL_VERSION"
if [[ "$STATUS" != "ok" ]]; then
  warn "Update finished with status: $STATUS"
fi
[[ -n "$LOG_FILE" ]] && log "log: $LOG_FILE"
printf '\n'
for line in "${SUMMARY[@]}"; do
  printf '  - %s\n' "$line"
done
printf '\n'

if (( JSON )); then
  printf '{"status":%s,"pi_version":%s,"old_version":%s,"target_version":%s,"channel":%s,"log":%s,"mode":%s}\n' \
    "$(json_escape "$STATUS")" \
    "$(json_escape "$FINAL_VERSION")" \
    "$(json_escape "$OLD_VERSION")" \
    "$(json_escape "$TARGET_VERSION")" \
    "$(json_escape "$TAG")" \
    "$(json_escape "${LOG_FILE:-}")" \
    "$(json_escape "$(current_mode)")" >&3
fi

[[ "$STATUS" == "ok" || "$STATUS" == "rollback" ]]
