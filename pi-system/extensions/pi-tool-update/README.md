# pi-tool-update

Universal update entry point for the agent.

## What it does

Registers `/update` inside pi. The command calls
`~/pi-system/scripts/pi-update.sh`, the same script you can run from SSH:

```bash
pi-update                 # full update
pi-update --check         # read-only
pi-update --self          # pi CLI only
pi-update --models        # refresh model catalog
```

## `/update` arguments

| Command | Effect |
|---|---|
| `/update` | Full update (repo + pi + extensions + models) |
| `/update check` | Show what would change, write nothing |
| `/update self` | pi CLI only |
| `/update models` | Model catalog only (OpenCode Go included) |
| `/update extensions` | Local extension dependencies + pi packages |
| `/update repo` | `git pull --ff-only --autostash` only |
| `/update --force` | Reinstall pi even if already current |
| `/update --no-autostash` | Skip the repo pull when local tracked changes exist (old behavior) |

After an update, restart pi (`/quit` and launch it again) so the new CLI is
loaded. The command itself keeps working because it only orchestrates the
shell script.

## Safety

- Runs `git pull --ff-only --autostash`: local tracked changes are stashed,
  the update is applied, then the changes are restored.
- If the autostash conflicts, rolls back to the previous commit and leaves the
  local changes intact (no conflict markers left behind).
- `--no-autostash` restores the old behavior: skip the pull when the checkout
  is dirty.
- In user mode it temporarily switches to dev and restores user mode on exit.
- Repairs the Termux shebang after every npm update.
- Records the previous version in `~/.pi/agent/pi-update-state.json`, so
  `pi-update --rollback` can reinstall it.

## Related

- `~/pi-system/scripts/pi-provider.sh` — switch between native providers
  (including `opencode-go`) and keep cron in sync.
- `~/pi-system/scripts/pi-remote.sh` — run updates over SSH from a PC.
