#!/data/data/com.termux/files/usr/bin/bash
# sftp-setup.sh — provision Termux sshd so Solid Explorer (or any SFTP client)
# can browse/edit ~/workspace from the phone or LAN.
#
# Usage:
#   bash ~/pi-system/scripts/sftp-setup.sh            # install + configure + start sshd, print connection info
#   bash ~/pi-system/scripts/sftp-setup.sh --keys     # also install your public key from ~/.ssh/authorized_keys.in
#   bash ~/pi-system/scripts/sftp-setup.sh --enable   # autostart sshd on Termux launch (termux-services)
#   bash ~/pi-system/scripts/sftp-setup.sh --status   # show port, user, IP, running state
#   bash ~/pi-system/scripts/sftp-setup.sh --stop     # stop sshd
#
# Termux sshd quirks worth knowing:
#   - Port is 8022 (NOT 22). Cannot bind <1024 without root.
#   - Username = `whoami` (e.g. u0_a123). NOT "root", NOT your Google account.
#   - Either set a password with `passwd` OR drop a public key in ~/.ssh/authorized_keys.
#   - sshd does not autostart unless termux-services is installed and enabled.
#   - LAN-only by default. For remote access tunnel through Tailscale / ngrok / Cloudflare Tunnel.

set -euo pipefail

PORT=8022
SSH_DIR="$HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
AUTH_KEYS_IN="$SSH_DIR/authorized_keys.in"

log()  { printf '\033[1;36m[sftp-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sftp-setup]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[sftp-setup]\033[0m %s\n' "$*" >&2; }

ensure_pkg() {
  local pkg="$1"
  if ! command -v "${2:-$pkg}" >/dev/null 2>&1; then
    log "Installing $pkg..."
    pkg install -y "$pkg"
  fi
}

get_ip() {
  ip -4 addr show 2>/dev/null \
    | awk '/inet / && $2 !~ /^127\./ {gsub(/\/.*/,"",$2); print $2; exit}'
}

print_status() {
  local user ip running
  user="$(whoami)"
  ip="$(get_ip || true)"
  if pgrep -x sshd >/dev/null 2>&1; then
    running="yes"
  else
    running="no"
  fi
  cat <<EOF

  sshd running : $running
  user         : $user
  port         : $PORT
  LAN IP       : ${ip:-<none — Wi-Fi off?>}
  workspace    : $HOME/workspace

EOF
}

print_solid_explorer_steps() {
  local user ip
  user="$(whoami)"
  ip="$(get_ip || echo '<phone-IP>')"
  cat <<EOF

  Solid Explorer setup
  --------------------
  1. Install Solid Explorer + the (free) "SFTP/FTP/Cloud" plugin from Play Store.
  2. New cloud connection -> SFTP.
       Host     : $ip
       Port     : $PORT
       Username : $user
       Auth     : password (set via 'passwd') OR private key matching ~/.ssh/authorized_keys
  3. Remote path: /data/data/com.termux/files/home/workspace
       (Termux \$HOME is sandboxed; absolute paths start with /data/data/com.termux/files)
  4. Save. Browsing /workspace lets you push/pull files the agent reads/writes.

  Tips
  ----
  - Phone IP changes per Wi-Fi. Re-run '--status' when reconnecting, or use mDNS / Tailscale.
  - Keep the Termux session alive while transferring (termux-wake-lock).
  - For remote access (outside LAN): tunnel via Tailscale ('pkg install tailscale').

EOF
}

cmd_install() {
  ensure_pkg openssh sshd
  ensure_pkg iproute2 ip

  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"

  if [[ ! -s "$AUTH_KEYS" ]]; then
    if [[ -s "$AUTH_KEYS_IN" ]]; then
      warn "No authorized_keys yet. Found authorized_keys.in -> run with --keys to install it."
    else
      warn "No authorized_keys and no password may be set. Run 'passwd' now, or drop your pubkey at:"
      warn "  $AUTH_KEYS_IN  then re-run with --keys"
    fi
  fi

  log "Starting sshd on port $PORT..."
  pkill -x sshd 2>/dev/null || true
  sshd
  print_status
  print_solid_explorer_steps
}

cmd_keys() {
  [[ -s "$AUTH_KEYS_IN" ]] || { err "Missing $AUTH_KEYS_IN — paste your public key there first."; exit 1; }
  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  cat "$AUTH_KEYS_IN" >> "$AUTH_KEYS"
  sort -u "$AUTH_KEYS" -o "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
  log "Installed key(s). authorized_keys now has $(wc -l < "$AUTH_KEYS") line(s)."
}

cmd_enable() {
  ensure_pkg termux-services sv
  mkdir -p "$HOME/.termux/boot" 2>/dev/null || true
  sv-enable sshd || true
  log "sshd enabled via termux-services. Termux:Boot (F-Droid) is required for boot-time autostart."
  log "Without Termux:Boot, sshd will start on the next Termux launch."
}

cmd_stop() {
  if pkill -x sshd; then
    log "sshd stopped."
  else
    warn "sshd was not running."
  fi
}

case "${1:-install}" in
  install|"")  cmd_install ;;
  --keys)      cmd_keys ;;
  --enable)    cmd_enable ;;
  --status)    print_status ;;
  --stop)      cmd_stop ;;
  -h|--help)
    sed -n '2,20p' "$0"
    ;;
  *)
    err "Unknown option: $1"
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
