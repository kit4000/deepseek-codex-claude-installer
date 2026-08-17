import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { EXTENSION_MARKER, SKILL_MARKER } from "./extensions.mjs";

export const CURSOR_CLI_MODELS = Object.freeze([
  Object.freeze({
    alias: "grok-4-6",
    aliases: Object.freeze([
      "grok-4-6",
      "grok",
      "cursor-grok-4.6",
      "cursor-grok-4.6-high-fast",
    ]),
    model: "cursor-grok-4.6-high-fast",
    displayName: "Cursor Grok 4.6",
    commandName: "cursor-grok-4-6",
    agentName: "cursor-grok-4-6",
  }),
  Object.freeze({
    alias: "composer-2-5",
    aliases: Object.freeze([
      "composer-2-5",
      "composer",
      "composer-2.5",
      "composer-2.5-fast",
    ]),
    model: "composer-2.5-fast",
    displayName: "Composer 2.5",
    commandName: "cursor-composer-2-5",
    agentName: "cursor-composer-2-5",
  }),
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function resolveCursorCliModel(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) throw new Error("Cursor CLI model is required");
  const entry = CURSOR_CLI_MODELS.find((candidate) => (
    candidate.alias.toLowerCase() === key
    || candidate.model.toLowerCase() === key
    || candidate.aliases.some((alias) => alias.toLowerCase() === key)
  ));
  if (!entry) throw new Error(`Unsupported Cursor CLI model: ${name}`);
  return entry;
}

export function boundCursorCliPrompt(prompt) {
  return [
    "You are a bounded Cursor CLI subagent billed to the user's Cursor subscription.",
    "Complete only the assigned task. Do not expand scope, publish, or do extra billable work.",
    "Never read, print, copy, or request API keys, tokens, or credentials.",
    "You are not alone in the codebase; preserve unrelated and concurrent edits.",
    "",
    "Assigned task:",
    String(prompt),
  ].join("\n");
}

export function buildCursorCliInvocation({
  agentBin,
  model,
  prompt,
  workspace,
  mode,
  force = true,
  trust = true,
} = {}) {
  if (!agentBin) throw new Error("Cursor CLI binary is required");
  const entry = resolveCursorCliModel(model);
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) throw new Error("A non-empty prompt is required");
  if (mode !== undefined && mode !== "ask" && mode !== "plan") {
    throw new Error(`Unsupported Cursor CLI mode: ${mode}`);
  }
  const argv = [
    "-p",
    "--output-format",
    "text",
    "--model",
    entry.model,
  ];
  if (trust) argv.push("--trust");
  if (force) argv.push("--force");
  if (mode) argv.push("--mode", mode);
  if (workspace) argv.push("--workspace", workspace);
  argv.push("--", boundCursorCliPrompt(trimmed));
  return { bin: agentBin, argv, model: entry };
}

export function cursorCliChildEnv(env = {}, { allowApiKey = false } = {}) {
  const next = { ...env };
  if (!allowApiKey) delete next.CURSOR_API_KEY;
  return next;
}

export function parseCursorCliAuth(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("Cursor CLI is not authenticated; run agent login");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (/not authenticated|logged out|unauthenticated/i.test(text) || !/authenticated|logged in/i.test(text)) {
      throw new Error("Cursor CLI is not authenticated; run agent login");
    }
    return { isAuthenticated: true };
  }
  const isAuthenticated = parsed.isAuthenticated === true || parsed.status === "authenticated";
  if (!isAuthenticated) throw new Error("Cursor CLI is not authenticated; run agent login");
  return {
    isAuthenticated: true,
    email: typeof parsed.userInfo?.email === "string" ? parsed.userInfo.email : undefined,
  };
}

export function resolveCursorAgentBin({
  env = process.env,
  home = env.HOME,
  exists = existsSync,
} = {}) {
  const explicit = env.CURSOR_AGENT_BIN;
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`Cursor CLI binary was not found at CURSOR_AGENT_BIN=${explicit}`);
    }
    return explicit;
  }
  const names = ["agent", "cursor-agent"];
  const dirs = [
    home ? join(home, ".local/bin") : undefined,
    "/usr/local/bin",
    ...(String(env.PATH ?? "").split(delimiter).filter(Boolean)),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error("Cursor CLI (`agent`) was not found. Install it from https://cursor.com/docs/cli/overview and run agent login.");
}

export function parseCursorCliArgs(argv, { cwd = process.cwd() } = {}) {
  const options = {
    model: undefined,
    workspace: cwd,
    mode: undefined,
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
    if (arg === "--model" || arg === "--workspace" || arg === "--mode") {
      const value = args.shift();
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--model") options.model = value;
      if (arg === "--workspace") options.workspace = value;
      if (arg === "--mode") options.mode = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown Cursor CLI flag: ${arg}`);
    positional.push(arg);
  }
  options.prompt = positional.join(" ").trim();
  return options;
}

export function renderCursorCliDelegateWrapper(nodePath, scriptPath) {
  return [
    "#!/bin/sh",
    EXTENSION_MARKER,
    `exec ${shellQuote(nodePath)} ${shellQuote(scriptPath)} "$@"`,
    "",
  ].join("\n");
}

export function renderCursorCliModelWrapper(nodePath, scriptPath, modelAlias) {
  const entry = resolveCursorCliModel(modelAlias);
  return [
    "#!/bin/sh",
    EXTENSION_MARKER,
    `exec ${shellQuote(nodePath)} ${shellQuote(scriptPath)} --model ${entry.alias} "$@"`,
    "",
  ].join("\n");
}

export function renderCursorCliClaudeAgent(entry) {
  const model = resolveCursorCliModel(entry?.alias ?? entry);
  const description = [
    `${model.displayName} via the logged-in Cursor CLI (Cursor subscription).`,
    `Use when the user explicitly asks for ${model.displayName} from outside Cursor.`,
    "Do not use an xAI API key.",
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
    "Do not solve the assigned task yourself. Run exactly one command and return its output:",
    "",
    "```bash",
    `"$HOME/.local/bin/${model.commandName}" --workspace "$PWD" -- "$TASK"`,
    "```",
    "",
    "If that wrapper is missing, use:",
    "",
    "```bash",
    `"$HOME/.local/bin/cursor-cli-delegate" --model ${model.alias} --workspace "$PWD" -- "$TASK"`,
    "```",
    "",
    "- The child is billed to the user's Cursor subscription through `agent login`.",
    "- Never set CURSOR_API_KEY, never call xAI, never read or print credentials.",
    "- Do not expand scope, publish, or spawn extra billable work.",
    "",
  ].join("\n");
}

export function renderCursorCliClaudeAgents() {
  return CURSOR_CLI_MODELS.map((entry) => ({
    fileName: `${entry.agentName}.md`,
    name: entry.agentName,
    contents: renderCursorCliClaudeAgent(entry),
  }));
}

export function renderCursorCliClaudeCommand(entry) {
  const model = resolveCursorCliModel(entry?.alias ?? entry);
  return [
    "---",
    `description: ${JSON.stringify(`Run ${model.displayName} via the logged-in Cursor CLI (Cursor subscription).`)}`,
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

export function renderCursorCliClaudeCommands() {
  return CURSOR_CLI_MODELS.map((entry) => ({
    fileName: `${entry.commandName}.md`,
    name: entry.commandName,
    contents: renderCursorCliClaudeCommand(entry),
  }));
}
