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

## Workflow

1. Run `update-claude-hybrid --check`.
2. Read its structured `status`, `summary`, `root_cause_hint`, `next_actions`, and `artifacts`.
3. If status is `success`, report that no rebuild is needed. Do not apply again.
4. If the official signature or either exact patch anchor fails, stop and report that the installer needs a version-specific update.
5. If Claude is running, ask the user to fully quit both apps. Do not terminate them yourself.
6. When the check reports a rebuild and the apps are closed, run `update-claude-hybrid --apply`.
7. Require the built-in non-billable ASAR, signature, router, model-list, patch-version, and shared-session verification to pass.
8. Run `prefer-claude-hybrid` so Launch Services unregisters Official and registers the daily Hybrid.
9. Ask the user to open `/Applications/Claude.app`, approve `Claude Safe Storage` with `Always Allow` if prompted, and confirm:
   - existing Code sessions are visible;
   - Fable 5 and Opus 4.8 remain native;
   - DeepSeek Pro and Flash appear in the 4.6 slots.

## Recovery

On error, follow only the returned safe retry instruction. Do not delete the Official source, session directories, Keychain entries, or `before-*` backups. If disk space is insufficient, report exact paths and ask the user before deleting any backup.

When a Claude release changes either exact anchor, update the configured chunk and anchor from the pristine Official ASAR, bump `patchVersion`, add the version fixture, and rebuild the archive. Never fuzzy-patch.
