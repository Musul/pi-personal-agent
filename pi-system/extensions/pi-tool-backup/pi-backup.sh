#!/bin/bash
# pi-backup.sh — backup tool for pi-mono based systems
#
# Modes:
#   --transfer (default)  Portable bundle for moving the whole agent to another device.
#                         Contains: extensions (no node_modules), docs, workspace,
#                         settings.json, telebridge.json, .env optional. Gets split if
#                         >45MB so Telegram accepts each part.
#   --full                Everything including logs. Never sent via Telegram.
#   --local-only          Generate tar in pi-system/logs/backups/ without sending.
#
# Flags:
#   --include-env         Include ~/.env in backup (off by default).
#   --include-logs        Include ~/pi-system/logs/ in transfer mode.
#   --no-send             Keep tar local, skip Telegram send.
#
# Env vars:
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  Required unless --no-send.
#   PI_BACKUP_MAX_MB                      Split size per part (default 45).

set -euo pipefail

MODE="transfer"
INCLUDE_ENV=false
INCLUDE_LOGS=false
NO_SEND=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transfer)     MODE="transfer"; shift ;;
    --full)         MODE="full"; shift ;;
    --local-only)   MODE="transfer"; NO_SEND=true; shift ;;
    --include-env)  INCLUDE_ENV=true; shift ;;
    --include-logs) INCLUDE_LOGS=true; shift ;;
    --no-send)      NO_SEND=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

HOME_DIR="${PI_HOME:-$HOME}"
BACKUP_DIR="$HOME_DIR/pi-system/logs/backups"
mkdir -p "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="pi-backup-${MODE}-${TS}.tar.gz"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
MANIFEST_NAME="pi-backup-${MODE}-${TS}.manifest.json"
MANIFEST_STAGE_DIR="$(mktemp -d)"
MANIFEST_PATH="$MANIFEST_STAGE_DIR/$MANIFEST_NAME"
trap 'rm -rf "$MANIFEST_STAGE_DIR"' EXIT
MAX_MB="${PI_BACKUP_MAX_MB:-45}"

write_manifest() {
  local ext_entries="{}"
  if [[ -f "$HOME_DIR/pi-system/registry.json" ]]; then
    ext_entries=$(cat "$HOME_DIR/pi-system/registry.json")
  fi
  cat >"$MANIFEST_PATH" <<EOF
{
  "timestamp": "$(date -Iseconds 2>/dev/null || date)",
  "mode": "$MODE",
  "include_env": $INCLUDE_ENV,
  "include_logs": $INCLUDE_LOGS,
  "hostname": "$(hostname 2>/dev/null || echo unknown)",
  "pi_system_path": "$HOME_DIR/pi-system",
  "workspace_path": "$HOME_DIR/workspace",
  "registry": $ext_entries
}
EOF
}

ITEMS=()
EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='*.log'
  --exclude='.DS_Store'
  --exclude='workspace/tmp/*'
  --exclude='pi-system/logs/backups/*'
)

case "$MODE" in
  transfer)
    ITEMS+=("workspace")
    ITEMS+=("pi-system/extensions")
    ITEMS+=("pi-system/docs")
    ITEMS+=("pi-system/scripts")
    [[ -f "$HOME_DIR/pi-system/registry.json" ]] && ITEMS+=("pi-system/registry.json")
    [[ -f "$HOME_DIR/.pi/agent/settings.json"  ]] && ITEMS+=(".pi/agent/settings.json")
    [[ -f "$HOME_DIR/.pi/agent/telebridge.json" ]] && ITEMS+=(".pi/agent/telebridge.json")
    [[ -f "$HOME_DIR/.pi/agent/pi-cron.tab"    ]] && ITEMS+=(".pi/agent/pi-cron.tab")
    if [[ "$INCLUDE_LOGS" == "true" ]]; then
      ITEMS+=("pi-system/logs")
    fi
    ;;
  full)
    ITEMS+=("workspace")
    ITEMS+=("pi-system")
    ITEMS+=(".pi/agent")
    ;;
esac

if [[ "$INCLUDE_ENV" == "true" ]]; then
  [[ -f "$HOME_DIR/.env" ]] && ITEMS+=(".env")
fi

REAL_ITEMS=()
for it in "${ITEMS[@]}"; do
  if [[ -e "$HOME_DIR/$it" ]]; then
    REAL_ITEMS+=("$it")
  fi
done

if [[ ${#REAL_ITEMS[@]} -eq 0 ]]; then
  echo "No items to back up. Aborting." >&2
  exit 1
fi

echo "Mode: $MODE"
echo "Items:"
printf '  ~/%s\n' "${REAL_ITEMS[@]}"

write_manifest
tar -czf "$BACKUP_PATH" \
  -C "$HOME_DIR" "${EXCLUDES[@]}" "${REAL_ITEMS[@]}" \
  -C "$MANIFEST_STAGE_DIR" "$MANIFEST_NAME"

SIZE_BYTES=$(stat -c%s "$BACKUP_PATH" 2>/dev/null || wc -c <"$BACKUP_PATH")
SIZE_MB=$(( (SIZE_BYTES + 1024*1024 - 1) / (1024*1024) ))
HUMAN_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
echo "Archive: $BACKUP_PATH ($HUMAN_SIZE)"

if [[ "$NO_SEND" == "true" ]]; then
  echo "Manifest embedded in archive as $MANIFEST_NAME"
  exit 0
fi

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
if [[ -z "$TOKEN" || -z "$CHAT_ID" ]]; then
  echo "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set. Keeping archive locally." >&2
  exit 0
fi

send_file() {
  local file="$1"
  local caption="$2"
  local response http_code body
  response=$(curl -s -w "\n%{http_code}" \
    -F "chat_id=$CHAT_ID" \
    -F "document=@$file" \
    -F "caption=$caption" \
    "https://api.telegram.org/bot$TOKEN/sendDocument")
  http_code=$(printf '%s\n' "$response" | tail -n1)
  body=$(printf '%s\n' "$response" | sed '$d')
  if [[ "$http_code" != "200" ]]; then
    echo "Send failed (HTTP $http_code):" >&2
    echo "$body" >&2
    return 1
  fi
}

if (( SIZE_MB <= MAX_MB )); then
  send_file "$BACKUP_PATH" "pi-backup ($MODE) $TS — $HUMAN_SIZE" || exit 1
  echo "Sent as single file."
else
  echo "Archive >${MAX_MB}MB. Splitting…"
  SPLIT_DIR="$BACKUP_DIR/split-${TS}"
  mkdir -p "$SPLIT_DIR"
  split -b "${MAX_MB}m" "$BACKUP_PATH" "$SPLIT_DIR/$BACKUP_NAME.part."
  PARTS=("$SPLIT_DIR"/"$BACKUP_NAME".part.*)
  TOTAL=${#PARTS[@]}
  i=1
  for p in "${PARTS[@]}"; do
    send_file "$p" "pi-backup ($MODE) $TS — part $i/$TOTAL" || exit 1
    i=$((i+1))
  done
  cat >"$SPLIT_DIR/REASSEMBLE.txt" <<EOF
To reassemble on destination device:
  cat $BACKUP_NAME.part.* > $BACKUP_NAME
Then run:
  bash pi-system/extensions/pi-tool-backup/restore.sh $BACKUP_NAME
EOF
  send_file "$SPLIT_DIR/REASSEMBLE.txt" "Reassembly instructions" || true
  echo "Sent ${TOTAL} parts."
fi

# Retain only 3 most recent archives
ls -1t "$BACKUP_DIR"/pi-backup-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/pi-backup-*.manifest.json 2>/dev/null | xargs -r rm -f

echo "Done."
