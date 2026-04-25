# pi-system

Modular agentic system built on top of `pi-mono`. Every piece under this tree is replaceable, individually versioned, and communicates via `pi.events` only.

## Quick references

- `docs/ARCHITECTURE.md` — layout + contract + rules.
- `docs/DEPENDENCIES.md` — auto-generated graph from manifests.
- `docs/developer/DEVELOPER-PROTOCOL.md` — mandatory checklist for any change under this tree.
- `registry.json` — source of truth for enabled extensions + versions.
- `scripts/set-mode.sh` — toggle user/dev mode (symlink + chmod).
- `scripts/gen-deps-map.js` — regenerate `DEPENDENCIES.md`.
- `scripts/migrate.sh` — one-shot migration from the legacy layout.
- `extensions/pi-tool-backup/pi-backup.sh` — portable backup that excludes `node_modules` and splits >45MB.
- `extensions/pi-tool-backup/restore.sh` — restore a backup on a fresh device.

## Rules

1. Agent writes to `~/workspace/`, never to `pi-system/` unless in dev mode.
2. Every extension folder: `manifest.json` + `package.json` + optional `CHANGES.md`.
3. Cross-extension communication goes through `pi.events`. No direct imports.
4. After editing any extension, run `node scripts/gen-deps-map.js` and append to its `CHANGES.md`.

## Modes

```bash
bash ~/pi-system/scripts/set-mode.sh user    # freeze system, user-facing AGENTS.md
bash ~/pi-system/scripts/set-mode.sh dev     # unfreeze, developer AGENTS.md
bash ~/pi-system/scripts/set-mode.sh status  # print current mode
```

## Backup

```bash
bash ~/pi-system/extensions/pi-tool-backup/pi-backup.sh --transfer           # send to Telegram
bash ~/pi-system/extensions/pi-tool-backup/pi-backup.sh --transfer --no-send # tar only
bash ~/pi-system/extensions/pi-tool-backup/restore.sh <archive> --install-deps
```
