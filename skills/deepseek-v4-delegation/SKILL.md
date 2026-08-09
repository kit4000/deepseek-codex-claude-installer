---
name: deepseek-v4-delegation
description: Use the installed DeepSeek V4 external API model as an optional callable subagent while keeping the parent and main model picker unchanged.
---
<!-- Managed by deepseek-codex-claude-installer. -->

# DeepSeek V4 Delegation

Use this skill when the user explicitly asks to delegate a bounded task to DeepSeek V4, compare work with DeepSeek, or use the external API as a subagent.

## Workflow

1. Confirm the requested delegation is bounded and that external API billing is intended or already approved.
2. Spawn `agent_type="deepseek-v4"` with a concrete task, explicit file or responsibility ownership, and the reminder that it is not alone in the codebase.
3. Do not override the model: the installed agent profile selects `deepseek/deepseek-v4-flash` with `max` reasoning through the loopback router.
4. Continue useful parent work while it runs when tasks are independent.
5. Inspect its evidence and any diff before integrating the result. The parent remains responsible for final design and verification.

## Boundaries

- This adds a callable option; it does not make DeepSeek the global default for subagents.
- It does not remove DeepSeek or GPT models from the main picker.
- Do not ask the child to read or print API keys. Authentication remains in the current user's Keychain.
- Do not delegate destructive actions, publication, or scope expansion without separate authorization.
