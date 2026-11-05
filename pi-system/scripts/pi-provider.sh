#!/usr/bin/env bash
# pi-provider.sh - inspect and switch the LLM provider used by the Pi agent.
#
# OpenCode Go is a native pi provider (provider id: opencode-go). It does not
# need an extension: pi ships the model catalog and reads OPENCODE_API_KEY or
# the "opencode-go" entry in ~/.pi/agent/auth.json. This script makes switching
# to it (and keeping cron in sync) a one-liner.
#
# Usage:
#   pi-provider.sh status
#   pi-provider.sh list [search]
#   pi-provider.sh use <provider> [model] [--cron|--no-cron]
#   pi-provider.sh verify
#   pi-provider.sh login
#
# Examples:
#   pi-provider.sh use opencode-go
#   pi-provider.sh use opencode-go kimi-k2.6
#   pi-provider.sh use opencode-go deepseek-v4.1-flash --cron
#   pi-provider.sh use moonshot kimi-k2.6
#
# `use` updates ~/.pi/agent/settings.json (defaultProvider/defaultModel) and,
# by default, the pi-cron provider/model so scheduled runs use the same brain.
# Note: pi-cron-forked spawns `pi -p` without --provider/--model, so cron
# actually inherits the global defaults. The pi-cron.* fields are kept in sync
# for compatibility; --no-cron only leaves that block untouched.
# It never touches API keys and never prints them.

set -euo pipefail

HOME_DIR="${PI_HOME:-$HOME}"
AGENT_DIR="$HOME_DIR/.pi/agent"
SETTINGS="$AGENT_DIR/settings.json"
ENV_FILE="$HOME_DIR/.env"

say()  { printf '\n==> %s\n' "$*"; }
log()  { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

have() { command -v "$1" >/dev/null 2>&1; }

# Load secrets from ~/.env without failing the script if a line is invalid.
load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set +u
    # shellcheck disable=SC1090
    source "$ENV_FILE" >/dev/null 2>&1 || true
    set -u
  fi
}

provider_env_var() {
  case "$1" in
    opencode-go|opencode) printf 'OPENCODE_API_KEY' ;;
    anthropic)            printf 'ANTHROPIC_API_KEY' ;;
    openai)               printf 'OPENAI_API_KEY' ;;
    openai-codex)         printf 'OPENAI_API_KEY' ;;
    google)               printf 'GEMINI_API_KEY' ;;
    deepseek)             printf 'DEEPSEEK_API_KEY' ;;
    groq)                 printf 'GROQ_API_KEY' ;;
    moonshot|moonshotai)  printf 'MOONSHOT_API_KEY' ;;
    kimi|kimi-coding)     printf 'KIMI_API_KEY' ;;
    zai)                  printf 'ZAI_API_KEY' ;;
    xai)                  printf 'XAI_API_KEY' ;;
    openrouter)           printf 'OPENROUTER_API_KEY' ;;
    minimax)              printf 'MINIMAX_API_KEY' ;;
    *)                    printf '' ;;
  esac
}

provider_key_present() {
  local provider="$1" var
  var="$(provider_env_var "$provider")"
  if [[ -n "$var" && -n "${!var:-}" ]]; then
    return 0
  fi
  [[ -f "$AGENT_DIR/auth.json" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const [file, provider] = process.argv.slice(1);
    try {
      const auth = JSON.parse(fs.readFileSync(file, "utf8"));
      process.exit(auth[provider] ? 0 : 1);
    } catch { process.exit(1); }
  ' "$AGENT_DIR/auth.json" "$provider"
}

settings_get() {
  local key="$1"
  [[ -f "$SETTINGS" ]] || return 0
  node -e '
    const fs = require("node:fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(s[process.argv[2]] ?? "");
  ' "$SETTINGS" "$key" 2>/dev/null || true
}

cron_get() {
  local key="$1"
  [[ -f "$SETTINGS" ]] || return 0
  node -e '
    const fs = require("node:fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(s["pi-cron"]?.[process.argv[2]] ?? "");
  ' "$SETTINGS" "$key" 2>/dev/null || true
}

model_exists() {
  local provider="$1" model="$2"
  have pi || return 1
  # A dummy key makes pi list models even when the real key is not exported yet.
  OPENCODE_API_KEY="${OPENCODE_API_KEY:-dummy}" \
    KIMI_API_KEY="${KIMI_API_KEY:-dummy}" \
    MOONSHOT_API_KEY="${MOONSHOT_API_KEY:-dummy}" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-dummy}" \
    pi --list-models "$model" 2>/dev/null \
    | awk -v p="$provider" -v m="$model" '$1 == p && $2 == m { found = 1 } END { exit found ? 0 : 1 }'
}

first_model_for_provider() {
  local provider="$1"
  have pi || return 1
  OPENCODE_API_KEY="${OPENCODE_API_KEY:-dummy}" \
    KIMI_API_KEY="${KIMI_API_KEY:-dummy}" \
    MOONSHOT_API_KEY="${MOONSHOT_API_KEY:-dummy}" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-dummy}" \
    pi --list-models 2>/dev/null \
    | awk -v p="$provider" '$1 == p { print $2; exit }'
}

default_model_for_provider() {
  local provider="$1" current="$2"
  case "$provider" in
    opencode-go)
      if [[ -n "$current" ]] && model_exists "$provider" "$current"; then
        printf '%s' "$current"
      elif model_exists "$provider" "kimi-k2.6"; then
        printf 'kimi-k2.6'
      else
        first_model_for_provider "$provider"
      fi
      ;;
    *)
      if [[ -n "$current" ]] && model_exists "$provider" "$current"; then
        printf '%s' "$current"
      else
        first_model_for_provider "$provider"
      fi
      ;;
  esac
}

set_settings() {
  local provider="$1" model="$2" update_cron="$3"
  [[ -f "$SETTINGS" ]] || die "Missing $SETTINGS. Start pi once to create it."
  local backup="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$backup"
  ls -1t "$SETTINGS".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f 2>/dev/null || true
  node - "$SETTINGS" "$provider" "$model" "$update_cron" <<'NODE'
const fs = require("node:fs");
const [, , file, provider, model, updateCron] = process.argv;
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
settings.defaultProvider = provider;
settings.defaultModel = model;
if (updateCron === "1" && settings["pi-cron"] && typeof settings["pi-cron"] === "object") {
  const cron = settings["pi-cron"];
  cron.provider = provider;
  cron.model = model;

  // Cron mode loads its own extension list. The Kimi fork is only needed for
  // the direct Kimi/Moonshot provider; OpenCode Go is native.
  const kimiFamily = new Set(["moonshot", "moonshotai", "kimi", "kimi-coding"]);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const kimiPkg = packages.find((p) => String(p).includes("pi-provider-kimi"));
  const kimiExt = kimiPkg ? String(kimiPkg).replace(/\/+$/, "") + "/extensions/index.ts" : "";
  const current = Array.isArray(cron.extensions) ? cron.extensions : [];
  const withoutKimi = current.filter((p) => !String(p).includes("pi-provider-kimi"));
  if (kimiFamily.has(provider) && kimiExt && !withoutKimi.includes(kimiExt)) {
    withoutKimi.push(kimiExt);
  }
  cron.extensions = withoutKimi;
}
const tmp = file + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
fs.renameSync(tmp, file);
NODE
  log "backup: $backup"
}

cmd_status() {
  load_env
  say "Pi"
  if have pi; then
    log "version: $(pi --version 2>/dev/null | head -n1)"
    log "binary:  $(command -v pi)"
  else
    warn "pi is not on PATH"
  fi
  log "settings: $SETTINGS"

  local provider model cron_provider cron_model mode
  provider="$(settings_get defaultProvider)"
  model="$(settings_get defaultModel)"
  cron_provider="$(cron_get provider)"
  cron_model="$(cron_get model)"
  if [[ -f "$HOME_DIR/pi-system/.mode" ]]; then
    mode="$(cat "$HOME_DIR/pi-system/.mode" 2>/dev/null || echo unknown)"
  else
    mode="unknown"
  fi

  say "Defaults"
  log "agent: ${provider:-unset} / ${model:-unset}"
  log "cron:  ${cron_provider:-unset} / ${cron_model:-unset}"
  log "mode:  $mode"

  if [[ -n "$provider" ]]; then
    local var
    var="$(provider_env_var "$provider")"
    if provider_key_present "$provider"; then
      log "key:   present${var:+ (env $var or auth.json)}"
    else
      warn "key:   missing${var:+ (export $var in ~/.env, or run /login in pi)}"
    fi
    if model_exists "$provider" "$model"; then
      log "native model: yes ($provider/$model)"
    else
      warn "native model: not found in the current catalog ($provider/$model)"
      if [[ "$provider" == "opencode-go" ]]; then
        warn "OpenCode Go needs pi >= 0.56.0. Run: pi-update"
      fi
    fi
  fi

  if [[ "$provider" == "opencode-go" || "$cron_provider" == "opencode-go" ]]; then
    say "OpenCode Go"
    log "Native in pi >= 0.56.0; no extension required."
    log "Provider id: opencode-go | env: OPENCODE_API_KEY | auth.json key: opencode-go"
    log "Endpoint: https://opencode.ai/zen/go (per-model API)"
  fi
}

cmd_list() {
  have pi || die "pi is not on PATH"
  load_env
  pi --list-models "$@" | ${PAGER:-cat}
}

cmd_verify() {
  load_env
  local provider model base key http tmp count
  provider="$(settings_get defaultProvider)"
  model="$(settings_get defaultModel)"
  [[ "$provider" == "opencode-go" || "$provider" == "opencode" ]] || die "verify only supports opencode and opencode-go (current: ${provider:-unset})"
  key="${OPENCODE_API_KEY:-}"
  [[ -n "$key" ]] || die "OPENCODE_API_KEY is not set. Add it to ~/.env or run /login in pi."

  if [[ "$provider" == "opencode-go" ]]; then
    base="https://opencode.ai/zen/go/v1"
  else
    base="https://opencode.ai/zen/v1"
  fi

  tmp="$(mktemp 2>/dev/null || echo "${TMPDIR:-$HOME_DIR/workspace/tmp}/pi-verify.$$")"
  mkdir -p "$(dirname "$tmp")" 2>/dev/null || true
  http="$(curl -sS -o "$tmp" -w '%{http_code}' -H "Authorization: Bearer $key" "$base/models" 2>/dev/null || true)"
  if [[ "$http" != "200" ]]; then
    rm -f "$tmp"
    die "GET $base/models returned HTTP ${http:-error}. Check the key/subscription."
  fi
  count="$(node -e '
    const fs = require("node:fs");
    try { const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log((j.data || j.models || []).length); }
    catch { console.log("?") }
  ' "$tmp" 2>/dev/null || echo "?")"
  rm -f "$tmp"
  log "provider: $provider"
  log "model:    $model"
  log "endpoint: $base/models"
  log "HTTP:     $http"
  log "models:   $count"
}

cmd_use() {
  local provider="${1:-}" model="" update_cron=1
  [[ -n "$provider" ]] || die "Usage: pi-provider.sh use <provider> [model] [--cron|--no-cron]"
  shift || true
  if [[ $# -gt 0 && -n "${1:-}" && "${1:-}" != --* ]]; then
    model="$1"
    shift
  fi
  while (( $# )); do
    case "$1" in
      --cron)    update_cron=1 ;;
      --no-cron) update_cron=0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done

  have pi || die "pi is not on PATH"
  load_env

  if [[ -z "$model" ]]; then
    model="$(default_model_for_provider "$provider" "$(settings_get defaultModel)")"
  fi
  [[ -n "$model" ]] || die "Could not pick a model for provider '$provider'. Pass one explicitly."
  if ! model_exists "$provider" "$model"; then
    if [[ "$provider" == "opencode-go" ]]; then
      die "Model '$model' is not available. OpenCode Go needs pi >= 0.56.0; run: pi-update"
    fi
    die "Model '$model' is not available for provider '$provider'. Run: pi-provider.sh list"
  fi

  if ! provider_key_present "$provider"; then
    local var
    var="$(provider_env_var "$provider")"
    warn "No credential found for '$provider'${var:+ (expected $var or auth.json/$provider)}."
    warn "The switch will be saved, but requests will fail until the key is configured."
    warn "Add it to ~/.env, or run /login inside pi and choose $provider."
  fi

  say "Switching provider"
  log "agent: $provider / $model"
  if [[ "$update_cron" == "1" ]]; then
    log "cron:  $provider / $model"
  else
    warn "--no-cron leaves the pi-cron block untouched, but cron still inherits defaultProvider/defaultModel in this fork."
  fi
  set_settings "$provider" "$model" "$update_cron"

  if [[ "$provider" == "opencode-go" ]]; then
    say "OpenCode Go"
    log "Native provider enabled. No extension is loaded for it."
    log "Restart pi (or run /reload) to pick up the new default."
  else
    log "Restart pi (or run /reload) to pick up the new default."
  fi
}

cmd_login() {
  cat <<EOF
Run pi interactively and use /login:

  pi
  /login        # choose OpenCode Go, paste the API key
  /model        # choose a Go model

Or keep the key in ~/.env:

  export OPENCODE_API_KEY="sk-..."
  source ~/.env

Pi reads OPENCODE_API_KEY for both "opencode" (Zen) and "opencode-go" (Go).
EOF
}

case "${1:-}" in
  status)  cmd_status ;;
  list)    shift; cmd_list "$@" ;;
  use)     shift; cmd_use "$@" ;;
  verify)  cmd_verify ;;
  login)   cmd_login ;;
  ""|-h|--help) usage ;;
  *)       usage >&2; die "Unknown command: $1" ;;
esac
