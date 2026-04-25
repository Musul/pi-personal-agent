# ARCHITECTURE — Pi-based Agentic System

Three disjoint trees on the device:

| Tree | Owner | Writable by agent? |
|---|---|---|
| `~/.pi/` | `pi-mono` (the harness) | No. Only pi-mono writes here. |
| `~/pi-system/` | You (system author) | Dev mode: yes. User mode: no (chmod a-w). |
| `~/workspace/` | The user (human) | Always yes. |

## Why three trees

- `pi-mono` gets updated via `npm`. If your custom stuff lived inside `~/.pi/`, an update could wipe it. Keeping your extensions, docs, and scripts in `~/pi-system/` isolates them from the harness lifecycle.
- `~/workspace/` is where the user's data lives: notes, finance CSVs, memory of past sessions, ephemeral files. The agent has full freedom here.
- `~/pi-system/` holds the "system" code and documentation. In user mode it is frozen at the filesystem level so a misbehaving agent cannot corrupt the system by editing its own extensions.

## `~/pi-system/` layout

```
pi-system/
├── extensions/             One folder per extension.
│   ├── pi-channel-telegram/      Telegram I/O (channel)
│   ├── pi-provider-kimi/         LLM provider fork
│   ├── pi-cron-forked/           Scheduler fork
│   ├── pi-tool-archive/          Session archiving
│   ├── pi-tool-backup/           Backup + restore
│   ├── pi-tool-elevenlabs/       STT/TTS
│   ├── pi-tool-finanzas/         Finance + investments
│   ├── pi-tool-parse-document/   PDF/DOCX/XLSX/images
│   ├── pi-tool-tavily/           Web research
│   └── _archive/                 Historical / unused sources
├── docs/
│   ├── ARCHITECTURE.md           This file
│   ├── DEPENDENCIES.md           Auto-generated from manifests
│   ├── developer/
│   │   └── DEVELOPER-PROTOCOL.md Rules when modifying the system
│   └── extensions/               One doc per extension (optional)
├── logs/
│   ├── backups/                  Retained backup archives
│   ├── cron/                     pi-cron-forked job logs
│   ├── sessions/
│   │   ├── archives/             >7d memory entries (rotated from workspace)
│   │   └── raw/                  raw .jsonl session dumps (optional)
│   └── system/                   errors, extension logs
├── scripts/
│   ├── gen-deps-map.js           Regenerate DEPENDENCIES.md from manifests
│   └── set-mode.sh               Switch user/dev mode, toggle chmod + symlink
├── registry.json                 Source of truth: enabled extensions + versions
└── .mode                         Current mode (user|dev), written by set-mode.sh
```

## Extension contract

Every extension folder MUST contain:

1. `manifest.json` — machine-readable metadata (name, type, reads, writes, events, deps, env). Consumed by `gen-deps-map.js`.
2. `package.json` — standard Node metadata; its `pi.extensions` field (when present) is what pi-mono loads.
3. `CHANGES.md` — only for forks of upstream packages. Document every divergence.
4. One of: `src/index.ts`, `./index.js`, or a single entry `.js`/`.sh` script.

Extensions MUST NOT import each other directly. All cross-extension talk goes through `pi.events` emit/on. If two extensions need tight coupling, merge them into one.

## Dependency map

`DEPENDENCIES.md` is regenerated from each extension's manifest. Update workflow:

1. Change `manifest.json` of the extension you touched.
2. Run `node ~/pi-system/scripts/gen-deps-map.js`.
3. Commit both the manifest and the regenerated `DEPENDENCIES.md`.

## Mode switching

- `bash ~/pi-system/scripts/set-mode.sh user` — freeze pi-system, symlink AGENTS.md → AGENTS.user.md.
- `bash ~/pi-system/scripts/set-mode.sh dev`  — unfreeze, symlink AGENTS.md → AGENTS.dev.md.

In dev mode the agent sees the Developer Protocol and may modify extensions under the constraints there. In user mode the filesystem refuses writes to pi-system/.

## Backup / restore

- `bash ~/pi-system/extensions/pi-tool-backup/pi-backup.sh --transfer` — generate portable bundle (excludes node_modules), split if >45MB, send to Telegram.
- `bash ~/pi-system/extensions/pi-tool-backup/restore.sh <archive>` — restore on another device.
