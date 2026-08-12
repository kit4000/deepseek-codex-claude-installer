---
name: claude-hybrid-update
description: Safely check and rebuild the daily Claude Hybrid app from a pristine official source, preserving sessions, native models, and Keychain boundaries.
---
<!-- Managed by deepseek-codex-claude-installer. -->

# Claude Hybrid Update

Use this skill when the user asks to update, refresh, repair, or check compatibility of Claude Hybrid.

## Safety contract

- Daily app: `/Applications/Claude.app` is the Hybrid, displayed as Claude.
- Pristine source: `~/Applications/Claude Official.app` is Apple-signed and must never be ASAR-patched.
- Do not use the in-app updater on Hybrid. Replace the pristine Official source first, then rebuild.
- Never copy or display API keys, Claude credentials, or session data.
- Never kill Claude processes. Ask the user to fully quit official Claude and Claude Hybrid when required.
- Never fuzzy-patch a new Claude build. An exact-anchor failure is a stop condition.
- Do not run the billable smoke test as part of an update unless the user separately approves billing.
- Preserve Fable 5 and Opus 4.8 as native models. Only the Opus 4.6 and Sonnet 4.6 slots are relabeled/routed.

## Proven update pattern

This is the formal end-to-end pattern verified on Claude `1.28929.0` / patch `2026-08-12.1`.

1. Read the public feed:
   `https://downloads.claude.ai/releases/darwin/universal/RELEASES.json`
2. Download `releases[0].updateTo.url` (or the requested version) and extract `Claude.app`.
3. Verify the staged app:
   - `codesign --verify --deep --strict`
   - notarized Developer ID via `spctl -a -vv`
4. Ask the user to fully quit both Claude apps (`pgrep -x Claude` must be empty).
5. Timestamp-backup and replace `~/Applications/Claude Official.app` with the staged app (`ditto` or equivalent). Do not ASAR-patch Official.
6. Run `update-claude-hybrid --check`.
7. If anchors fail (`status=error`), update installer config from the pristine Official ASAR (§ Anchor maintenance), sync the persistent installer copy, then `--check` again. Never fuzzy-patch.
8. When `--check` reports a rebuild and apps are closed, run `update-claude-hybrid --apply`.
9. Require the built-in non-billable verification to pass (ASAR, signature, router, model list, patch version, shared session dir, `DISABLE_AUTOUPDATER=1`).
10. Run `prefer-claude-hybrid` so Launch Services prefers `/Applications/Claude.app`.
11. Ask the user to open `/Applications/Claude.app`, approve `Claude Safe Storage` with `Always Allow` if prompted, and confirm:
    - existing Code sessions are visible;
    - Fable 5 and Opus 4.8 remain native;
    - DeepSeek Pro and Flash appear in the 4.6 slots.

### Helper notes

- `update-claude-hybrid` and `prefer-claude-hybrid` live under `~/.local/bin` and must keep their managed markers.
- If `--apply` refuses to overwrite `prefer-claude-hybrid`, restore the managed helper that starts with `# Managed by deepseek-codex-claude-installer.`
- Keep both the git repo and `~/Applications/deepseek-codex-claude-installer` configs in sync when anchors change.

## Workflow (already-up-to-date Official)

1. Run `update-claude-hybrid --check`.
2. Read its structured `status`, `summary`, `root_cause_hint`, `next_actions`, and `artifacts`.
3. If status is `success`, report that no rebuild is needed. Do not apply again.
4. If the official signature or either exact patch anchor fails, stop and report that the installer needs a version-specific update.
5. If Claude is running, ask the user to fully quit both apps. Do not terminate them yourself.
6. When the check reports a rebuild and the apps are closed, run `update-claude-hybrid --apply`.
7. Require the built-in non-billable verification to pass.
8. Run `prefer-claude-hybrid`.
9. Ask the user to open `/Applications/Claude.app` and confirm the UI checks above.

## Anchor maintenance

When a Claude release changes either exact anchor:

1. Extract Official `Contents/Resources/app.asar`.
2. Find exactly one `ANTHROPIC_BASE_URL:e.apiHost` hit → `app.patchFile` / `app.patchFrom`.
3. Find exactly one
   `function <name>(e){return <VAR>=new a.WebContentsView(e),t.c(<VAR>.webContents,t.n.CLAUDE_AI_WEB),<VAR>.webContents.setMaxListeners(20),<VAR>}`
   hit → `app.modelLabelPatchFile` / `app.modelLabelPatchFrom`.
4. Bump `app.patchVersion` (example: `2026-08-12.1`).
5. Update `CHANGE_SPEC-claude-app-layout-and-updates.md` history table, tests, and `INSTALLER_MANIFEST.json`.
6. Rebuild Hybrid with `--check` / `--apply`. Never fuzzy-patch.

Current verified anchors for Claude `1.28929.0`:

- `patchFile`: `/.vite/build/index.chunk-KnwvxAXh.js`
- `patchFrom`: `ANTHROPIC_BASE_URL:e.apiHost`
- `modelLabelPatchFile`: `/.vite/build/index.chunk-CHjD_WiU.js`
- `modelLabelPatchFrom`: `function ti(e){return J=new a.WebContentsView(e),t.c(J.webContents,t.n.CLAUDE_AI_WEB),J.webContents.setMaxListeners(20),J}`
- `patchVersion`: `2026-08-12.1`

## Recovery

On error, follow only the returned safe retry instruction. Do not delete the Official source, session directories, Keychain entries, or `before-*` backups. If disk space is insufficient, report exact paths and ask the user before deleting any backup.
