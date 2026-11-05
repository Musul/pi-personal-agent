# Remote management over Termux SSH

This document describes the white-label process for managing a Pi agent that
runs inside Termux on an Android phone from a PC. Everything here uses
placeholders: no real phone IP, Termux user, hostname or key belongs in the
repository.

## How it fits together

```
PC (client)                         Phone (Termux)
┌──────────────────────┐            ┌──────────────────────────────┐
│ pi-remote.sh         │  SSH 8022  │ sshd                         │
│ ~/.config/pi/        │ ─────────▶ │ ~/pi-system/scripts/         │
│   remote.env         │            │   pi-update.sh               │
│ ~/.ssh/id_ed25519    │            │   pi-provider.sh             │
└──────────────────────┘            │ ~/workspace/                 │
                                    └──────────────────────────────┘
```

The phone runs the agent. The PC only opens an SSH connection and runs the
same scripts that are available locally in `~/pi-system/scripts/`.

## 1. Phone side (Termux)

Install OpenSSH and start `sshd`:

```bash
pkg install openssh -y
sshd
```

Or use the helper, which also prints the connection data:

```bash
bash ~/pi-system/scripts/sftp-setup.sh
bash ~/pi-system/scripts/sftp-setup.sh --status
```

Expected output includes:

```text
sshd running : yes
user         : <termux-user>
port         : 8022
LAN IP       : <phone-ip>
workspace    : /data/data/com.termux/files/home/workspace
SSH command  : ssh -p 8022 <termux-user>@<phone-ip>
```

If `LAN IP` says `<none — Wi-Fi off?>`, the phone has no LAN address. Connect
it to the same Wi-Fi as the PC, use Tailscale, or use USB tethering. A mobile
data IP is not reachable from the PC.

### Authorize the PC key

Preferred: key-only authentication. On the PC, the public key is usually
`~/.ssh/id_ed25519.pub`. On the phone:

```bash
bash ~/pi-system/scripts/sftp-setup.sh --key "ssh-ed25519 AAAA... you@pc"
```

Or with a file:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

You can add the key before or after a connection attempt: `sshd` reads
`authorized_keys` on every new connection, so no restart is needed.

Permissions matter:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

## 2. PC side

Requirements: `ssh` and `scp` (OpenSSH client). On Windows, install the
OpenSSH Client optional feature or use Git Bash.

Clone the repository and configure the wrapper:

```bash
git clone https://github.com/<your-github-user>/pi-personal-agent.git
cd pi-personal-agent

bash pi-system/scripts/pi-remote.sh setup \
  --host <phone-ip> \
  --user <termux-user> \
  --port 8022 \
  --key ~/.ssh/id_ed25519
```

`setup` writes `~/.config/pi/remote.env` with permissions `600`. It contains no
secrets: only the phone address, SSH user, port and the local key path.

You can also use the template manually:

```bash
cp pi-system/config/pi-remote.env.example ~/.config/pi/remote.env
chmod 600 ~/.config/pi/remote.env
# edit the placeholders
```

Test it:

```bash
bash pi-system/scripts/pi-remote.sh status
```

## 3. Daily commands

| Command | What it does |
|---|---|
| `pi-remote.sh status` | Phone info, Pi version, provider/model, update check |
| `pi-remote.sh update --yes` | Runs `pi-update` on the phone |
| `pi-remote.sh provider status` | Shows the active provider and cron model |
| `pi-remote.sh provider use opencode-go <model>` | Switches agent + cron on the phone |
| `pi-remote.sh shell` | Interactive SSH shell |
| `pi-remote.sh run '<command>'` | Runs one remote command |
| `pi-remote.sh push <local> <remote>` | Copies a file with `scp` |
| `pi-remote.sh print` | Prints the effective SSH command |

Examples:

```bash
bash pi-system/scripts/pi-remote.sh update --check
bash pi-system/scripts/pi-remote.sh update --yes
bash pi-system/scripts/pi-remote.sh provider use opencode-go kimi-k2.7-code
bash pi-system/scripts/pi-remote.sh provider verify
bash pi-system/scripts/pi-remote.sh push ./AGENTS.user.md '~/workspace/AGENTS.user.md'
```

## 4. Troubleshooting

### `LAN IP: <none — Wi-Fi off?>`

The phone has no non-loopback IPv4 address. Turn on Wi-Fi and join the same
network as the PC, use Tailscale on both devices, or enable USB tethering.
A carrier/mobile-data address is not reachable from the PC.

### TCP connects but SSH resets before the banner

Typical causes: a VPN/AdGuard-style local VPN on the phone, a firewall, or a
different process owning the port. Check the effective config:

```bash
which sshd
sshd -T | grep -Ei '^(port|listenaddress|hostkey|pubkeyauthentication|passwordauthentication)'
```

`ss -ltnp` normally returns `Permission denied` in Termux without root; that is
expected. `sshd -T` is enough to verify the config.

Run a foreground debug SSH server on a spare port:

```bash
pkill -x sshd
sshd -D -e -p 2222
```

Important: `sshd -d` handles one connection and exits; `sshd -D -e` stays in the
foreground and logs every attempt.

From another Termux session, test locally:

```bash
ssh -p 2222 <termux-user>@127.0.0.1
```

The phone does not have the PC's private key, so it may ask for a password.
That prompt is expected; press `Ctrl+C`. The important part is that the banner
and `sshd -D -e` log appear. If the local test works but the PC gets a reset,
the problem is in the network path or a VPN/firewall between them.

### Key authentication still asks for a password

- Confirm the public key is in `~/.ssh/authorized_keys` on the phone.
- `chmod 700 ~/.ssh` and `chmod 600 ~/.ssh/authorized_keys`.
- Use the matching private key on the PC: `ssh -i ~/.ssh/id_ed25519 ...`.
- Test non-interactively: `ssh -o BatchMode=yes ...`. If BatchMode fails, the
  key is not being accepted.
- The phone asking for a password when connecting to `127.0.0.1` is normal: the
  private key lives on the PC, not on the phone.

### Port 8022 is occupied

Use a spare port for the debug server (`2222`, `2223`, ...) and inspect the
real listener. If another app owns `8022`, stop it or choose a different port
and update `PI_TERMUX_PORT` in `~/.config/pi/remote.env`.

## 5. Security

- Prefer key-only auth; disable password auth if you do not need it.
- Do not expose port `8022` directly to the internet. Use Tailscale, a VPN, or
  an SSH tunnel.
- `pi-remote.sh` uses `StrictHostKeyChecking=accept-new`: it trusts a new host
  key once, then protects against changes.
- Keep `~/.config/pi/remote.env` at `600`. It has no secrets, but it does reveal
  your LAN topology.
- Never commit real IPs, usernames, hostnames, keys or `.env` files.

## 6. White-label checklist

Before publishing a fork:

```bash
git grep -n -E '192\.168\.|10\.[0-9]+\.|100\.[0-9]+\.|u0_a[0-9]+|@gmail|@outlook'
```

The repository should contain only placeholders such as `<phone-ip>`,
`<termux-user>`, `<your-github-user>` and `192.0.2.10` (a documentation IP from
RFC 5737). Real connection data belongs in `~/.config/pi/remote.env` on each
user's PC, never in the repo.

## Related

- `pi-system/scripts/pi-update.sh` — universal updater.
- `pi-system/scripts/pi-provider.sh` — provider/model switch.
- `pi-system/extensions/pi-tool-update/` — `/update` command.
- `pi-system/docs/ARCHITECTURE.md` — system layout.
