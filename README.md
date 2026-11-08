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
  costos/                   AI spend ledger (usage/cost from sessions)
  tmp/                      scratch (Termux-safe; /tmp is denied)
pi-system/                  system code (read-only in user mode)
  extensions/               one folder per pluggable extension
  docs/                     ARCHITECTURE, DEPENDENCIES, REMOTE-TERMUX, developer protocol
  logs/                     backups/, cron/, sessions/{archives,raw}, system/
  config/                   pi-remote.env.example (PC-side template)
  scripts/                  set-mode, gen-deps-map, migrate, sftp-setup, pi-update, pi-provider, pi-remote
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
| `pi-tool-costos` | tool | AI spend ledger from session usage/cost; `/costos` reports, optional Telegram |
| `pi-tool-backup` | tool | Portable backup bundle, excludes `node_modules`, splits >45MB for Telegram |
| `pi-tool-update` | tool | Universal `/update` + `pi-update` command: pi CLI, repo, extension deps, model catalog, Termux shebang repair |
| `pi-tool-elevenlabs` | tool | STT/TTS + send voice messages to Telegram |
| `pi-tool-finanzas` | tool | Personal finance + investment tracking with optional secondary-currency support (FX provider/label/symbol fully configurable via env), DCA helpers |
| `pi-tool-parse-document` | tool | PDF/DOCX/XLSX/PPTX/image parsing with OCR fallback |
| `pi-tool-tavily` | tool | Web search/extract/map via Tavily through a Cloudflare Worker |

Full machine-readable metadata in each extension's `manifest.json`. Dependency graph in [`pi-system/docs/DEPENDENCIES.md`](pi-system/docs/DEPENDENCIES.md) — auto-generated from manifests.

Default LLM is Kimi/Moonshot (`kimi-k2.6`) via `pi-provider-kimi`. Cron subprocesses inherit the same `defaultProvider` / `defaultModel`, so scheduled runs use the same model as the interactive agent by default. Both configured in [`.pi/agent/settings.json`](.pi/agent/settings.json).

OpenCode Go is also supported **natively** by pi (provider id `opencode-go`, no extension required). See [OpenCode Go](#opencode-go).

Tavily can be routed through a Cloudflare Worker proxy when the direct API is WAF-blocked from your region — see [`pi-system/extensions/pi-tool-tavily/worker/README.md`](pi-system/extensions/pi-tool-tavily/worker/README.md).

## OpenCode Go

Pi has native support for the [OpenCode Go](https://opencode.ai/go) subscription since `pi-coding-agent` **0.56.0**. No fork, no custom provider, no `models.json` entry is required:

- **Provider id:** `opencode-go`
- **Endpoint:** per-model under `https://opencode.ai/zen/go` (OpenAI-compatible, Anthropic Messages, Google and Responses APIs; pi ships the right one for each model)
- **Credential:** `OPENCODE_API_KEY` in the environment, or the `opencode-go` entry in `~/.pi/agent/auth.json` (written by `/login`)

Setup:

```bash
# Option A — interactive login inside pi
pi
/login          # choose OpenCode Go, paste the key
/model          # pick a Go model

# Option B — keep the key in ~/.env
echo 'export OPENCODE_API_KEY="sk-..."' >> ~/.env
source ~/.env
```

Switch the agent **and cron** to OpenCode Go with one command:

```bash
bash ~/pi-system/scripts/pi-update.sh                    # ensures pi >= 0.56 + fresh model catalog
bash ~/pi-system/scripts/pi-provider.sh use opencode-go
bash ~/pi-system/scripts/pi-provider.sh status
bash ~/pi-system/scripts/pi-provider.sh verify        # checks key + subscription against /models
```

The switch is written to `~/.pi/agent/settings.json` (`defaultProvider` / `defaultModel` and the `pi-cron` block). `pi-provider.sh` does not print or store the key. To pin a specific model, pass it as the second argument: `pi-provider.sh use opencode-go kimi-k2.6`. If you already have a Kimi direct key, you can switch back the same way:

```bash
bash ~/pi-system/scripts/pi-provider.sh use moonshot kimi-k2.6
```

> **Version note:** OpenCode Go support landed in pi `0.56.0`. The updater enforces a compatible version and refreshes the model catalog with `pi update --models`. Current pi releases need Node >= 22.19; on older Node the updater uses the `legacy-node20` channel automatically.

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

Budget about **3 GB free** in Termux's home. A full install (CLI + global forks + extension `node_modules`) uses roughly 1.5 GB, plus room for sessions and backups.

First, update Termux's package index and upgrade installed packages. You'll be prompted a few times during the upgrade (config file overwrites, service restarts) — accept each one with **Y** + Enter:

```bash
apt update && apt full-upgrade
```

Then install the runtime dependencies:

```bash
pkg install nodejs git poppler tesseract curl -y
```
```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

> `@mariozechner/pi-coding-agent` is deprecated. Use `@earendil-works/pi-coding-agent`. Current releases require **Node >= 22.19**; on Node 20 use the `legacy-node20` channel (the updater does this automatically).

#### If `node -v` fails with `libicui18n.so.78`

Termux sometimes publishes `node` / `nodejs-lts` built against the previous ICU
while `libicu` has already moved to the next soname. `npm` then fails before it
even starts:

```text
CANNOT LINK EXECUTABLE "node": library "libicui18n.so.78" not found
```

Pin `libicu` to the version Node was built against (78.3 at the time of writing)
and verify:

```bash
apt-get install -y --allow-downgrades libicu=78.3
apt-mark hold libicu
hash -r
node -v
```

The hold keeps `pkg upgrade` from re-breaking Node. Once Termux rebuilds Node
against the new ICU, lift the hold and upgrade:

```bash
apt-mark unhold libicu
pkg upgrade
```

If `78.3` is no longer in the repo, list what is available with
`apt-cache madison libicu` and pin the older entry.

Install the upstream packages that the local forks (`pi-provider-kimi`, `pi-cron-forked`) seed from. `migrate.sh` copies these into `pi-system/extensions/` and renames them so future `npm update` of the upstream cannot overwrite local changes — but the upstream must exist globally first or the migration will silently skip the fork population:

```bash
npm install -g kimicodeprovider @e9n/pi-cron
```

Clone the repo and move its contents directly into `$HOME`. The agent expects `~/workspace/`, `~/pi-system/`, and `~/.pi/` at the home root — **not** inside a subdirectory:

```bash
cd ~
```
```bash
git clone https://github.com/<your-github-user>/pi-personal-agent.git
```

Replace `<your-github-user>` with the GitHub account or organization that hosts
your fork. The rest of the install commands are distribution-agnostic.
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

Verify the toolchain and that every extension loads:

```bash
node -v
npm -v
pi --version
pi list
pi --help >/dev/null && echo "extensions OK"
```

`pi --help` loads all extensions; if one fails, it prints the failing path and
the missing module before the help text.

> When running `pi -p` over SSH or from a script, add `</dev/null`. Without it,
> `pi` waits for stdin EOF and looks hung even though the model already replied.

> **npm 12+** blocks `git:` dependencies by default. `migrate.sh` passes
> `--allow-git=all` automatically on npm >= 12. If an older checkout reports
> `EALLOWGIT` while installing `pi-tool-parse-document`, run:
>
> ```bash
> (cd ~/pi-system/extensions/pi-tool-parse-document && \
>   npm install --omit=dev --no-audit --no-fund --allow-git=all)
> ```

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

Replace every placeholder before the first run. A fake Telegram token makes the
channel extension retry `getUpdates` and log errors; an empty provider key makes
`pi` fail at the first prompt. Validate credentials without starting a session:

```bash
pi auth check --provider moonshot        # or: --provider opencode-go
```

### Home-screen widget (Termux:Widget)

Termux:Widget lives in F-Droid and launches the scripts in `~/.shortcuts/`. It
shares Termux's UID, so it can read them directly. Enable external commands,
patch `pi`'s shebang (Termux:Widget cannot use `#!/usr/bin/env node`), and
create the shortcut:

```bash
echo 'allow-external-apps=true' >> ~/.termux/termux.properties
termux-reload-settings
pkg install which -y
termux-fix-shebang "$(command -v pi)"
mkdir -p ~/.shortcuts
```

```bash
cat > ~/.shortcuts/pi.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH"
source "$HOME/.env"
termux-wake-lock
cd "$PI_WORKSPACE" || cd "$HOME/workspace" || exit 1
exec "${PREFIX:-/data/data/com.termux/files/usr}/bin/pi"
EOF
chmod 700 ~/.shortcuts/pi.sh
```

Then long-press the home screen → **Widgets** → **Termux:Widget** → drop the
widget and pick `pi`. If the widget shows no shortcuts, run
`termux-reload-settings` and add it again. `pi-update` repairs the shebang after
npm updates.

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
   - **Username** — output of `whoami` in Termux (`<termux-user>`)
   - **Auth** — password
4. **Remote path**: `/data/data/com.termux/files/home`

### SSH from a PC (remote management)

The same `sshd` that powers SFTP also gives you a shell for updates and provider changes. On the phone:

```bash
bash ~/pi-system/scripts/sftp-setup.sh --status   # prints IP, user, port and the exact ssh command
bash ~/pi-system/scripts/sftp-setup.sh --key "ssh-ed25519 AAAA... you@pc"
```

From the PC:

```bash
# Option A: let the wrapper write ~/.config/pi/remote.env
bash pi-system/scripts/pi-remote.sh setup \
  --host <phone-ip> \
  --user <termux-user> \
  --port 8022 \
  --key ~/.ssh/id_ed25519

# Option B: copy the template and edit the placeholders
cp pi-system/config/pi-remote.env.example ~/.config/pi/remote.env
chmod 600 ~/.config/pi/remote.env

bash pi-system/scripts/pi-remote.sh status
```

`<phone-ip>` is the phone LAN IP or Tailscale IP, and `<termux-user>` is the
output of `whoami` inside Termux. The wrapper also supports:

```bash
bash pi-system/scripts/pi-remote.sh update --yes
bash pi-system/scripts/pi-remote.sh provider use opencode-go
bash pi-system/scripts/pi-remote.sh push ./AGENTS.user.md '~/workspace/AGENTS.user.md'
bash pi-system/scripts/pi-remote.sh shell
```

`pi-remote.sh` is a thin SSH/SCP wrapper: it does not store credentials and
does not need to run on the phone. Full setup, troubleshooting and the
white-label checklist are in
[`pi-system/docs/REMOTE-TERMUX.md`](pi-system/docs/REMOTE-TERMUX.md).

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
- Autostart and active hours live in `.pi/agent/settings.json` under `pi-cron`.
- Cron subprocesses inherit `defaultProvider` / `defaultModel`; `pi-provider.sh` keeps the `pi-cron.provider` / `pi-cron.model` fields in sync for compatibility, but the effective model comes from the global default.
- Job logs land in `pi-system/logs/cron/`.

Repo ships with two defaults in [`.pi/agent/pi-cron.tab`](.pi/agent/pi-cron.tab):

- `revisar-tareas` — every 12h, reads `workspace/TAREAS.md` and ejecuta tareas pendientes autónomamente.
- `archivar-memoria` — daily 03:00, runs `pi-tool-archive` para rotar sesiones.

Edit or delete them freely — the file is yours. Manage from inside pi via `/cron` commands (added by the extension).

## Updating pi

One command updates everything: the pi CLI, the `pi-personal-agent` checkout (only when clean), local extension dependencies, and the model catalog (including OpenCode Go models). It also repairs the Termux shebang after npm rewrites it.

```bash
pi-update                # full update
pi-update --check        # read-only summary
pi-update --self         # pi CLI only
pi-update --models       # model catalog only
pi-update --rollback     # reinstall the version recorded before the last update
```

From inside pi:

```text
/update
/update check
/update models
```

If the `pi-update` shim is missing (first install, or after restoring a backup):

```bash
bash ~/pi-system/scripts/pi-update.sh
# then, on Termux:
ln -sfn ~/pi-system/scripts/pi-update.sh "$PREFIX/bin/pi-update"
```

The updater handles user mode automatically: it temporarily switches `pi-system/` to dev mode, updates, and restores user mode on exit. Local tracked changes are never clobbered: `git pull` runs with `--autostash`, so the update is applied and the changes are restored afterwards. If the autostash conflicts, the updater rolls back to the previous commit, leaves the local changes intact, and tells you how to resolve it. Use `--no-autostash` to keep the old skip-when-dirty behavior. Logs land in `pi-system/logs/system/`, and the previous pi version is stored in `~/.pi/agent/pi-update-state.json` for `--rollback`.

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
| `--transfer` (default) | Portable bundle: workspace + extensions + docs + scripts + minimal `.pi` config (settings, `models.json`, cron, telebridge). Excludes `node_modules`, `.git`, logs, tmp. |
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
