# DEVELOPER PROTOCOL

You only read this in **developer mode**. In user mode, `~/pi-system/` is frozen at the filesystem level (`chmod a-w`) and writes fail.

## Golden rule

Dev mode is for intentional, reviewed changes to the system. Not for improvising.

## Before you edit any file under `~/pi-system/extensions/`

1. Open the file. Check the top-of-file header comment. Look for:
   - `@module`
   - `@reads` / `@writes`
   - `@user-docs`
   - `@touching-me-means`
2. Open the extension's `manifest.json`. Compare `reads`, `writes`, `emits_events`, `consumes_events`, `depends_on` to reality.
3. Read `~/pi-system/docs/DEPENDENCIES.md` section for the event you're about to change. Find every consumer.

## After you edit

Required follow-ups, in order:

1. **Update `manifest.json`** of the extension you touched. If you added a new read/write path, event, env var, or dependency — record it.
2. **Bump the version** in `package.json` and `manifest.json` (semver: breaking = major, additive = minor, fix = patch).
3. **Append to `CHANGES.md`** in that extension folder, with date + one-line summary + reason.
4. **Regenerate DEPENDENCIES.md**:
   ```bash
   node ~/pi-system/scripts/gen-deps-map.js
   ```
5. **Sanity-check event consumers.** If you changed an emitted event, grep for the event name under `~/pi-system/extensions/` and verify consumers still work.
6. **Test.** At minimum invoke the CLI/command path once. Ideally add/update a smoke test under the extension folder.

## Propagating changes to user-facing docs

If your change affects how the **user** interacts with the system (new command, renamed flag, new data file, new required env var):

1. Draft the proposed patch to `~/workspace/AGENTS.user.md`.
2. Show the diff to the owner (`diff -u AGENTS.user.md AGENTS.user.md.new`).
3. Only apply on explicit approval.
4. Never inject into `AGENTS.md` directly — it is a symlink to the user or dev file.

If your change affects only how the **developer agent** should think about the system (architecture, protocol, new invariants):

1. Edit `~/pi-system/docs/developer/DEVELOPER-PROTOCOL.md` (this file) or add a new doc under `~/pi-system/docs/developer/`.
2. Update `AGENTS.dev.md` if the developer workflow has changed.

## Architectural invariants (do not violate)

- Extensions never import each other. Always via `pi.events`.
- Tools never write code into `~/pi-system/`. Only data/output files may be written, and only to paths declared in their manifest `writes`.
- Runtime state (tokens, configs that the extension maintains) lives in `~/.pi/agent/`. Static config that a human edits lives in the extension folder. User data lives in `~/workspace/`.
- Forks of upstream packages keep their CHANGES.md up to date so a future rebase is feasible.

## When something feels load-bearing but undocumented

Add it to `~/pi-system/docs/extensions/<name>.md` with a header explaining the non-obvious invariant. Future-you thanks present-you.

## When in doubt

Stop and ask the owner. A wrong change in dev mode can break the entire system, and the only safety net is the backup.
