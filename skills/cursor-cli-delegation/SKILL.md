---
name: cursor-cli-delegation
description: Delegate a bounded task to Cursor Grok 4.6 or Composer 2.5 by wrapping the logged-in Cursor CLI so usage bills to the Cursor subscription, not an xAI or extra API key.
---
<!-- Managed by deepseek-codex-claude-installer. -->

# Cursor CLI Delegation

Use this skill when the user asks to run Cursor Grok 4.6 or Composer 2.5 from
outside Cursor (Claude Code, Codex, or a terminal) against the Cursor
subscription.

These models are not Claude.app picker rows. Composer has no public Messages
API, and an xAI key would be separate billing. The supported path is the
logged-in Cursor CLI.

## Commands

Prefer the wrappers on `PATH`, or the absolute paths Claude.app can see:

```bash
"$HOME/.local/bin/cursor-grok-4-6" --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/cursor-composer-2-5" --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/cursor-cli-delegate" --model grok-4-6 --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/cursor-cli-delegate" --model composer-2-5 --mode ask --workspace "$PWD" -- "question"
"$HOME/.local/bin/cursor-cli-delegate" --check-auth
```

In Claude Code, a new session can also use `/cursor-grok-4-6`, `/cursor-composer-2-5`,
or the named agents `cursor-grok-4-6` and `cursor-composer-2-5`. Those wrappers must
shell out to the commands above and must not implement the task on the parent model.

## Authentication

- Require `agent login`. `cursor-cli-delegate --check-auth` confirms it.
- Do not set `CURSOR_API_KEY`. The wrapper strips it so billing stays on the
  Cursor subscription.
- Do not call xAI, OpenAI, or Anthropic as a stand-in for these two models.

If `agent` is missing, tell the user to install Cursor CLI from
https://cursor.com/docs/cli/overview and then run `agent login`.

## Boundaries

- Keep the prompt bounded. Print mode can write files and run shell commands.
- Do not read, print, copy, or request API keys or tokens.
- Do not hijack additional Claude.app picker rows for Cursor models.
- Do not change global subagent defaults.
