---
name: chatgpt-codex-delegation
description: Delegate a bounded task to GPT-5.6 Sol or Luna by wrapping the logged-in Codex CLI so usage bills to the ChatGPT subscription, not an OpenAI API key.
---
<!-- Managed by deepseek-codex-claude-installer. -->

# ChatGPT Codex Delegation

Use this skill when the user asks to run GPT-5.6 Sol or GPT-5.6 Luna from
Claude Code against the ChatGPT subscription.

These models are not Claude.app picker rows. ChatGPT subscription is not an
OpenAI API key. The supported path is the logged-in Codex CLI.

## Commands

```bash
"$HOME/.local/bin/gpt-5-6-sol" --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/gpt-5-6-luna" --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/codex-cli-delegate" --model gpt-5-6-sol --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/codex-cli-delegate" --model gpt-5-6-luna --workspace "$PWD" -- "bounded task"
"$HOME/.local/bin/codex-cli-delegate" --check-auth
```

In Claude Code, a new session can also use `/gpt-5-6-sol`, `/gpt-5-6-luna`,
or the named agents `gpt-5-6-sol` and `gpt-5-6-luna`. Those wrappers must
shell out to the commands above and must not implement the task on the parent model.

## Authentication

- Require `codex login` with ChatGPT. `codex-cli-delegate --check-auth` confirms it.
- Do not set `OPENAI_API_KEY`. The wrapper strips it so billing stays on the
  ChatGPT subscription.
- Do not call the OpenAI API as a stand-in for these two models.

If `codex` is missing, tell the user to install Codex and then run `codex login`.

## Boundaries

- Keep the prompt bounded. Exec mode can write files and run shell commands.
- Do not read, print, copy, or request API keys or tokens.
- Do not hijack additional Claude.app picker rows for ChatGPT models.
- Do not change global subagent defaults.
