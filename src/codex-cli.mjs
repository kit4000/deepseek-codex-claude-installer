import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { EXTENSION_MARKER, SKILL_MARKER } from "./extensions.mjs";

export const CODEX_CLI_MODELS = Object.freeze([
  Object.freeze({
    alias: "gpt-5-6-sol",
    aliases: Object.freeze([
      "gpt-5-6-sol",
      "gpt-5.6-sol",
      "sol",
    ]),
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    commandName: "gpt-5-6-sol",
    agentName: "gpt-5-6-sol",
  }),
  Object.freeze({
    alias: "gpt-5-6-luna",
    aliases: Object.freeze([
      "gpt-5-6-luna",
      "gpt-5.6-luna",
      "luna",
    ]),
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    commandName: "gpt-5-6-luna",
    agentName: "gpt-5-6-luna",
  }),
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function resolveCodexCliModel(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) throw new Error("Codex CLI model is required");
  const entry = CODEX_CLI_MODELS.find((candidate) => (
    candidate.alias.toLowerCase() === key
    || candidate.model.toLowerCase() === key
    || candidate.aliases.some((alias) => alias.toLowerCase() === key)
  ));
  if (!entry) throw new Error(`Unsupported Codex CLI model: ${name}`);
  return entry;
}

export function boundCodexCliPrompt(prompt) {
  return [
    "You are a bounded Codex CLI subagent billed to the user's ChatGPT subscription.",
    "Complete only the assigned task. Do not expand scope, publish, or do extra billable work.",
    "Never read, print, copy, or request API keys, tokens, or credentials.",
    "You are not alone in the codebase; preserve unrelated and concurrent edits.",
    "",
    "Assigned task:",
    String(prompt),
  ].join("\n");
}

export function buildCodexCliInvocation({
  codexBin,
  model,
  prompt,
  workspace,
  sandbox = "workspace-write",
} = {}) {
  if (!codexBin) throw new Error("Codex CLI binary is required");
  const entry = resolveCodexCliModel(model);
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) throw new Error("A non-empty prompt is required");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error(`Unsupported Codex CLI sandbox: ${sandbox}`);
  }
  const argv = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    "-s",
    sandbox,
    "-m",
    entry.model,
  ];
  if (workspace) argv.push("-C", workspace);
  argv.push("--", boundCodexCliPrompt(trimmed));
  return { bin: codexBin, argv, model: entry };
}

export function codexCliChildEnv(env = {}, { allowApiKey = false } = {}) {
  const next = { ...env };
  if (!allowApiKey) {
    delete next.OPENAI_API_KEY;
    delete next.CODEX_API_KEY;
  }
  return next;
}

export function parseCodexLoginStatus(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("Codex CLI is not authenticated; run codex login");
  if (/logged in using an api key/i.test(text)) {
    throw new Error("Codex CLI is using an API key; run codex login so ChatGPT subscription billing is used");
  }
  if (/logged in using chatgpt/i.test(text)) {
    return { isAuthenticated: true, method: "chatgpt" };
  }
  if (/not logged|logged out|unauthenticated/i.test(text)) {
    throw new Error("Codex CLI is not authenticated; run codex login");
  }
  throw new Error("Codex CLI is not authenticated with ChatGPT; run codex login");
}

export function codexLoginStatusText(result = {}) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function resolveCodexBin({
  env = process.env,
  home = env.HOME,
  exists = existsSync,
} = {}) {
  const explicit = env.CODEX_BIN;
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`Codex CLI binary was not found at CODEX_BIN=${explicit}`);
    }
    return explicit;
  }
  const dirs = [
    home ? join(home, ".local/bin") : undefined,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    ...(String(env.PATH ?? "").split(delimiter).filter(Boolean)),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "codex");
    if (exists(candidate)) return candidate;
  }
  throw new Error("Codex CLI (`codex`) was not found. Install Codex and run `codex login`.");
}

export function parseCodexCliArgs(argv, { cwd = process.cwd() } = {}) {
  const options = {
    model: undefined,
    workspace: cwd,
    sandbox: undefined,
    dryRun: false,
    allowApiKey: false,
    checkAuth: false,
    help: false,
    prompt: "",
  };
  const args = [...argv];
  const positional = [];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") {
      positional.push(...args);
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--allow-api-key") {
      options.allowApiKey = true;
      continue;
    }
    if (arg === "--check-auth") {
      options.checkAuth = true;
      continue;
    }
    if (arg === "--model" || arg === "--workspace" || arg === "--sandbox") {
      const value = args.shift();
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--model") options.model = value;
      if (arg === "--workspace") options.workspace = value;
      if (arg === "--sandbox") options.sandbox = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown Codex CLI flag: ${arg}`);
    positional.push(arg);
  }
  options.prompt = positional.join(" ").trim();
  return options;
}

export function renderCodexCliDelegateWrapper(nodePath, scriptPath) {
  return [
    "#!/bin/sh",
    EXTENSION_MARKER,
    `exec ${shellQuote(nodePath)} ${shellQuote(scriptPath)} "$@"`,
    "",
  ].join("\n");
}

export function renderCodexCliModelWrapper(nodePath, scriptPath, modelAlias) {
  const entry = resolveCodexCliModel(modelAlias);
  return [
    "#!/bin/sh",
    EXTENSION_MARKER,
    `exec ${shellQuote(nodePath)} ${shellQuote(scriptPath)} --model ${entry.alias} "$@"`,
    "",
  ].join("\n");
}

export function renderCodexCliClaudeAgent(entry) {
  const model = resolveCodexCliModel(entry?.alias ?? entry);
  const description = [
    `${model.displayName} via the logged-in Codex CLI (ChatGPT subscription).`,
    `Use when the user explicitly asks for ${model.displayName} from outside Codex.`,
    "Do not use an OpenAI API key.",
  ].join(" ");
  return [
    "---",
    `name: ${model.agentName}`,
    `description: ${JSON.stringify(description)}`,
    "tools: Bash",
    "---",
    SKILL_MARKER,
    "",
    "You are a wrapper, not the implementation model.",
    "",
    "Do not solve the assigned task yourself. Copy the assigned task text from this conversation",
    "into the quoted prompt. Do not leave the prompt empty and do not expand $TASK or $ARGUMENTS.",
    "",
    "```bash",
    `"$HOME/.local/bin/${model.commandName}" --workspace "$PWD" -- "ASSIGNED_TASK_TEXT"`,
    "```",
    "",
    "If that wrapper is missing, use:",
    "",
    "```bash",
    `"$HOME/.local/bin/codex-cli-delegate" --model ${model.alias} --workspace "$PWD" -- "ASSIGNED_TASK_TEXT"`,
    "```",
    "",
    "- The child is billed to the user's ChatGPT subscription through `codex login`.",
    "- Never set OPENAI_API_KEY, never call the OpenAI API, never read or print credentials.",
    "- Do not expand scope, publish, or spawn extra billable work.",
    "",
  ].join("\n");
}

export function renderCodexCliClaudeAgents() {
  return CODEX_CLI_MODELS.map((entry) => ({
    fileName: `${entry.agentName}.md`,
    name: entry.agentName,
    contents: renderCodexCliClaudeAgent(entry),
  }));
}

export function renderCodexCliClaudeCommand(entry) {
  const model = resolveCodexCliModel(entry?.alias ?? entry);
  return [
    "---",
    `description: ${JSON.stringify(`Run ${model.displayName} via the logged-in Codex CLI (ChatGPT subscription).`)}`,
    "---",
    SKILL_MARKER,
    "",
    "Do not implement the task yourself. Run exactly one command and return its output:",
    "",
    "```bash",
    `"$HOME/.local/bin/${model.commandName}" --workspace "$PWD" -- "$ARGUMENTS"`,
    "```",
    "",
  ].join("\n");
}

export function renderCodexCliClaudeCommands() {
  return CODEX_CLI_MODELS.map((entry) => ({
    fileName: `${entry.commandName}.md`,
    name: entry.commandName,
    contents: renderCodexCliClaudeCommand(entry),
  }));
}

export function canReplaceHybridApiAgent(existing) {
  if (typeof existing !== "string" || existing.length === 0) return false;
  return existing.includes("<!-- Managed by claude-hybrid. -->")
    && /gpt-5-6-(sol|luna)/.test(existing)
    && existing.includes("Claude Hybrid");
}
