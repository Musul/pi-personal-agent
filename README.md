# Pi Agent

Modular agentic system for Termux on Android. Runs a persistent, personal AI agent on your phone. Built on top of [`pi-mono`](https://github.com/badlogic/pi-mono) — this repo is the layer above: the extensions, the docs, the backup pipeline, the user/dev mode split.

Designed for two audiences: yourself, and customers who want a ready-to-run agent without having to assemble one.

## What's in here

```
.pi/agent/                  pi-mono runtime (tracked: settings.json only)
  settings.json             provider, model, autoload extensions
  telebridge.json           Telegram link state (gitignored)
  pi-cron.tab               cron jobs (tracked; ships with defaults)
workspace/                  user-owned data — agent writes freely here
  AGENTS.md                 symlink → AGENTS.user.md or AGENTS.dev.md
  AGENTS.user.md / .dev.md  agent persona + tool docs (committed)
  TAREAS.md                 autonomous task list, read on every session
  memory/                   session archives (md + html)
  finanzas/                 transactions, loans, investments (CSV/JSON)
  tmp/                      scratch (Termux-safe; /tmp is denied)
pi-system/                  system code (read-only in user mode)
  extensions/               one folder per pluggable extension
  docs/                     ARCHITECTURE, DEPENDENCIES, developer protocol
  logs/                     backups/, cron/, sessions/{archives,raw}, system/
  scripts/                  set-mode, gen-deps-map, migrate, sftp-setup
  registry.json             source of truth: enabled extensions + versions
  .mode                     current mode marker (user|dev)
```

Three hard rules:

1. `~/.pi/` is owned by `pi-mono`. Never hand-edit.
2. `~/pi-system/` is the system. In **user mode** the filesystem refuses writes (`chmod a-w`); in **dev mode** it's writable.
3. `~/workspace/` belongs to the user. Agent writes freely here.

## Extensions

| Name | Type | What it does |
|---|---|---|
| `pi-channel-telegram` | channel | Two-way Telegram relay (messages, voice, photos, documents, tool-call notifications, cron results) |
| `pi-provider-kimi` | provider | Local fork of `kimicodeprovider` — LLM provider for Kimi/Moonshot |
| `pi-cron-forked` | scheduler | Local fork of `@e9n/pi-cron` — scheduled agent runs, emits `cron:job_complete` |
| `pi-tool-archive` | tool | Archive latest session as markdown + HTML; auto-rotate entries >7d |
| `pi-tool-backup` | tool | Portable backup bundle, excludes `node_modules`, splits >45MB for Telegram |
| `pi-tool-elevenlabs` | tool | STT/TTS + send voice messages to Telegram |
| `pi-tool-finanzas` | tool | Personal finance + investment tracking with optional secondary-currency support (FX provider/label/symbol fully configurable via env), DCA helpers |
| `pi-tool-parse-document` | tool | PDF/DOCX/XLSX/PPTX/image parsing with OCR fallback |
| `pi-tool-tavily` | tool | Web search/extract/map via Tavily through a Cloudflare Worker |

Full machine-readable metadata in each extension's `manifest.json`. Dependency graph in [`pi-system/docs/DEPENDENCIES.md`](pi-system/docs/DEPENDENCIES.md) — auto-generated from manifests.

Default LLM is Kimi/Moonshot (`kimi-k2.6`) via `pi-provider-kimi`. Cron-mode default is `kimi-k2.5`. Both configured in [`.pi/agent/settings.json`](.pi/agent/settings.json).

Tavily can be routed through a Cloudflare Worker proxy when the direct API is WAF-blocked from your region — see [`pi-system/extensions/pi-tool-tavily/worker/README.md`](pi-system/extensions/pi-tool-tavily/worker/README.md).

## Architecture

Extensions never import each other. All cross-extension talk goes through `pi.events` emit/on. Full contract in [`pi-system/docs/ARCHITECTURE.md`](pi-system/docs/ARCHITECTURE.md).

Each extension carries:

- `manifest.json` — reads, writes, events, deps, env (the contract).
- `package.json` — Node metadata, entry points.
- `CHANGES.md` — only for forks; documents divergence from upstream.

Forked upstream packages are renamed locally (`pi-provider-kimi`, `pi-cron-forked`) so `npm update` of the upstream cannot overwrite local changes.

## User mode vs developer mode

The same agent installation runs in two modes. The filesystem enforces the boundary — no prompt engineering required:

- **user** — default. `pi-system/{extensions,docs,scripts}` chmod to `a-w`. Agent can only write to `~/workspace/` and its own runtime state in `~/.pi/agent/`. `AGENTS.md` symlinks to `AGENTS.user.md`.
- **dev** — system is unfrozen. `AGENTS.md` symlinks to `AGENTS.dev.md`, which includes the Developer Protocol and the dependency map.

`AGENTS.user.md` and `AGENTS.dev.md` are committed sources of truth — edit those, never the symlink. Both define the agent's persona, red lines, and per-tool docs.

**Personalización conversacional (no es un wizard):** ambos archivos arrancan con bloques `<!-- ASK:* -->` en los campos `USER_NAME`, `USER_LOCATION`, `USER_TZ`, `USER_NOTES`, `AGENT_NAME`. Cada bloque le indica al agente que pregunte ese dato de forma natural en la primera conversación y, cuando lo tenga, edite **ambos** `AGENTS.*.md` reemplazando el placeholder y borrando el bloque ASK. Resultado: la primera vez que abrís `pi`, el agente te saluda, te pide tu nombre, te invita a bautizarlo y va aprendiendo tu zona horaria sobre la marcha — sin formularios. Idempotente: si un campo ya está resuelto (no quedan `<!-- ASK:* -->` ni `{{...}}` literales), no vuelve a preguntar.

## Install on a fresh Termux

### 0. Install Termux from F-Droid (not Play Store)

The Play Store build is outdated and broken. Use F-Droid:

1. Install **F-Droid**: <https://f-droid.org/F-Droid.apk>
2. Open F-Droid → search **Termux** → Install: <https://f-droid.org/packages/com.termux/>
3. Same source, install **Termux:Widget** (needed for the home-screen launcher later): <https://f-droid.org/packages/com.termux.widget/>
4. Open Termux once so it provisions `$HOME`.

### 1. Disable battery optimization for Termux

Android will kill Termux in the background otherwise — your agent stops, cron stops, the Telegram bridge dies.

Settings → **Apps** → **Termux** → **Battery** → set to **Unrestricted** (some OEMs label it "Don't optimize" or "No restrictions"). Repeat for **Termux:Widget**.

### 2. Base packages

First, update Termux's package index and upgrade installed packages. You'll be prompted a few times during the upgrade (config file overwrites, service restarts) — accept each one with **Y** + Enter:

```bash
apt update && apt full-upgrade
```

Then install the runtime dependencies:

```bash
pkg install nodejs-lts git poppler tesseract curl -y
```
```bash
npm install -g @mariozechner/pi-coding-agent
```

Install the upstream packages that the local forks (`pi-provider-kimi`, `pi-cron-forked`) seed from. `migrate.sh` copies these into `pi-system/extensions/` and renames them so future `npm update` of the upstream cannot overwrite local changes — but the upstream must exist globally first or the migration will silently skip the fork population:

```bash
npm install -g kimicodeprovider @e9n/pi-cron
```

Clone the repo and move its contents directly into `$HOME`. The agent expects `~/workspace/`, `~/pi-system/`, and `~/.pi/` at the home root — **not** inside a subdirectory:

```bash
cd ~
```
```bash
git clone https://github.com/Musul/pi-personal-agent.git
```
```bash
shopt -s dotglob                  # so the move includes .pi/ and .env.example
```
```bash
mv pi-personal-agent/* ~/
```
```bash
rmdir pi-personal-agent
```
```bash
ls -la ~/                         # sanity-check: workspace/ pi-system/ .pi/ .env.example must be visible
```

Populate the forks (one-time) and install deps. Run without `--apply` first for a dry-run summary:

```bash
bash ~/pi-system/scripts/migrate.sh           # dry run
bash ~/pi-system/scripts/migrate.sh --apply   # execute
```

Pick the agent mode. **user** locks `pi-system/` read-only and points `AGENTS.md` at the customer persona; **dev** unlocks the system and switches to the developer protocol. The migration script already left you in **dev** — run this only if you want **user** mode for a customer-ready install:

```bash
bash ~/pi-system/scripts/set-mode.sh user    # customer-ready (read-only system)
bash ~/pi-system/scripts/set-mode.sh dev     # author-ready  (writable system)
bash ~/pi-system/scripts/set-mode.sh status  # check current mode
```

Copy `.env.example` to `~/.env`, fill values, source it from `~/.bashrc`:

```bash
cp .env.example ~/.env && echo 'source ~/.env' >> ~/.bashrc
```

Required keys: `MOONSHOT_API_KEY`, `TAVILY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ELEVENLABS_API_KEY`. Optional: `TAVILY_PROXY_URL` (Cloudflare Worker), `PI_BACKUP_INCLUDE_ENV`, `PI_BACKUP_MAX_MB`, `FX_*` (locale/currency), `FINANZAS_DATA_DIR`. Full reference + comments in [`.env.example`](.env.example).

## SFTP from your phone (Solid Explorer)

Browse and edit `~/workspace/` from any SFTP client on the same Wi-Fi — useful for dropping CSVs into `finanzas/`, pulling session archives, or editing `AGENTS.md` from a real keyboard.

One-shot setup inside Termux:

```bash
bash ~/pi-system/scripts/sftp-setup.sh
```

That script installs `openssh`, starts `sshd` on port **8022**, and prints the exact host/user/port to enter into Solid Explorer.

```bash
passwd
```

Solid Explorer connection (Android):

1. Install **Solid Explorer** + its free **SFTP/FTP/Cloud plugin** from Play Store.
2. New cloud connection → **SFTP**.
3. Fill in:
   - **Host** — phone LAN IP (Settings → WiFi → IP Address)
   - **Port** — `8022`
   - **Username** — output of `whoami` in Termux (e.g. `u0_a123`)
   - **Auth** — password
4. **Remote path**: `/data/data/com.termux/files/home`

### First launch — Telegram

Inside pi (`/telegram setup` once to link the bot, then `/telegram autostart` to enable session-start auto-relay):

```text
/telegram setup        # one-time: paste bot token, send /start to bot to discover chat ID
/telegram autostart    # toggle auto-enable on every session_start (persisted in telebridge.json)
/telegram tools        # toggle tool-execution notifications on/off (persisted in telebridge.json, survives sessions)
/telegram status       # check bot, relay, and autostart state
```

After `autostart` is on, every time you launch `pi` (manually or via the home-screen widget) the Telegram channel comes up automatically — no `/telegram` toggle needed.

## Home-screen widget (Termux:Widget)

One-tap launch from the Android home screen. Termux:Widget itself was installed in step 0 of the install section.

1. Confirm **Termux:Widget** is installed from F-Droid (not Play Store) and has battery set to **Unrestricted** in Android settings.
2. After installing the agent, fix the `pi` shebang so the widget can spawn it:

   ```bash
   pkg install which -y
   termux-fix-shebang $(which pi)
   ```

3. Create a launcher script and make it executable:

   ```bash
   mkdir -p ~/.shortcuts
   cat > ~/.shortcuts/pi.sh <<'EOF'
   #!/data/data/com.termux/files/usr/bin/bash
   source "$HOME/.env"
   termux-wake-lock
   sshd
   cd "$PI_WORKSPACE" || cd ~/workspace || exit 1
   pi
   EOF
   chmod +x ~/.shortcuts/pi.sh
   ```

4. Long-press the home screen → **Widgets** → **Termux:Widget** → pick `pi.sh`.

## Scheduled runs (pi-cron)

`pi-cron-forked` runs the agent on a cron schedule and emits `cron:job_complete` so `pi-channel-telegram` forwards results to your phone.

- Schedule file: `~/.pi/agent/pi-cron.tab` (cron syntax + prompt).
- Autostart, active hours, and the cron-mode model live in `.pi/agent/settings.json` under `pi-cron`.
- Job logs land in `pi-system/logs/cron/`.

Repo ships with two defaults in [`.pi/agent/pi-cron.tab`](.pi/agent/pi-cron.tab):

- `revisar-tareas` — every 12h, reads `workspace/TAREAS.md` and ejecuta tareas pendientes autónomamente.
- `archivar-memoria` — daily 03:00, runs `pi-tool-archive` para rotar sesiones.

Edit or delete them freely — the file is yours. Manage from inside pi via `/cron` commands (added by the extension).

## Updating pi

When a new `pi-coding-agent` release ships:

```bash
/quit                              # inside pi, if running
npm update -g @mariozechner/pi-coding-agent
pkg install which -y
termux-fix-shebang $(which pi)
```

The `termux-fix-shebang` step is required after every `npm update` — npm rewrites the bin shim with a non-Termux shebang and the widget won't launch until it's patched.

## Backup & transfer to another device

```bash
# on the source device
bash ~/pi-system/extensions/pi-tool-backup/pi-backup.sh --transfer

# on the destination device (Termux, pi-mono installed, env vars exported)
bash ~/pi-system/extensions/pi-tool-backup/restore.sh <bundle.tar.gz> --install-deps
```

`pi-backup.sh` modes and flags:

| Flag | Effect |
|---|---|
| `--transfer` (default) | Portable bundle: workspace + extensions + docs + scripts + minimal `.pi/agent` config. Excludes `node_modules`, `.git`, logs, tmp. |
| `--full` | Everything including `pi-system/logs/`. Never auto-sent. |
| `--local-only` | Same as `--transfer` but skips Telegram. |
| `--include-env` | Pull `~/.env` into the bundle. Off by default. Only enable if destination is fully trusted. |
| `--include-logs` | Add `pi-system/logs/` to a `--transfer` bundle. |
| `--no-send` | Build the tar but do not push to Telegram. |

If the archive exceeds `PI_BACKUP_MAX_MB` (default 45) it's split with `split` so each part fits Telegram's `sendDocument` limit, and a `REASSEMBLE.txt` is sent alongside. Reassemble on the destination:

```bash
cat pi-backup-transfer-*.part.* > pi-backup-transfer.tar.gz
```

Every bundle embeds a manifest (`pi-backup-*.manifest.json`) listing mode, hostname, paths, and the full `registry.json`.

`restore.sh` flags: `--target <dir>` (default `$HOME`), `--install-deps` (run `npm install` in every extension that has `package.json`).

## Developing a new extension

1. `cp -r pi-system/extensions/pi-tool-tavily pi-system/extensions/pi-tool-<yours>`
2. Rewrite `package.json`, `manifest.json`, entry script.
3. Declare `reads`, `writes`, `emits_events`, `consumes_events` honestly in the manifest — `gen-deps-map.js` uses them.
4. Add the name to `pi-system/registry.json`.
5. `node pi-system/scripts/gen-deps-map.js` to regenerate `docs/DEPENDENCIES.md`.
6. Add the extension path to `.pi/agent/settings.json.packages` if pi-mono has to load it.

Full protocol in [`pi-system/docs/developer/DEVELOPER-PROTOCOL.md`](pi-system/docs/developer/DEVELOPER-PROTOCOL.md).

## Status

Personal project. Public repo for transparency and portability — not (yet) a packaged product. Breaking changes will happen.

## License

See `LICENSE`. Upstream forks (`pi-provider-kimi`, `pi-cron-forked`) retain their original licenses — see each extension's folder.
