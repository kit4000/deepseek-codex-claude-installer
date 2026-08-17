import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EXTENSION_MARKER, SKILL_MARKER } from "../src/extensions.mjs";
import {
  CURSOR_CLI_MODELS,
  renderCursorCliClaudeAgents,
  renderCursorCliClaudeCommands,
} from "../src/cursor-cli.mjs";
import {
  CODEX_CLI_MODELS,
  renderCodexCliClaudeAgents,
  renderCodexCliClaudeCommands,
} from "../src/codex-cli.mjs";
import { CLAUDE_AGENT_MARKER, renderClaudeHybridAgents } from "../claude-hybrid/src/claude-agents.mjs";
import { projectRoot } from "./lib.mjs";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const codexHome = process.env.CODEX_HOME ?? resolve(home, ".codex");
const configPath = resolve(codexHome, "config.toml");
const profilePath = resolve(codexHome, "agent-profiles/deepseek-v4.toml");
const wrapperPath = resolve(home, ".local/bin/update-claude-hybrid");
const preferPath = resolve(home, ".local/bin/prefer-claude-hybrid");
const cursorDelegatePath = resolve(home, ".local/bin/cursor-cli-delegate");
const codexDelegatePath = resolve(home, ".local/bin/codex-cli-delegate");
const skillPaths = [
  resolve(codexHome, "skills/claude-hybrid-update/SKILL.md"),
  resolve(codexHome, "skills/deepseek-v4-delegation/SKILL.md"),
  resolve(codexHome, "skills/cursor-cli-delegation/SKILL.md"),
  resolve(home, ".claude/skills/cursor-cli-delegation/SKILL.md"),
  resolve(codexHome, "skills/chatgpt-codex-delegation/SKILL.md"),
  resolve(home, ".claude/skills/chatgpt-codex-delegation/SKILL.md"),
];
const checks = {};

async function check(name, action) {
  try {
    checks[name] = { ok: true, detail: await action() };
  } catch (error) {
    checks[name] = { ok: false, error: error.message };
  }
}

await check("deepseekSubagentRegistration", async () => {
  const source = await readFile(configPath, "utf8");
  if (!source.includes(EXTENSION_MARKER) || !source.includes("[agents.deepseek-v4]")) {
    throw new Error("Managed DeepSeek V4 agent registration is missing");
  }
  if (!source.includes(`config_file = ${JSON.stringify(profilePath)}`)) throw new Error("Agent profile path is stale");
  if (!/\[features\][\s\S]*?multi_agent\s*=\s*true/.test(source)) throw new Error("multi_agent is not enabled");
  return "callable as agent_type deepseek-v4 without changing the main model";
});

await check("deepseekSubagentProfile", async () => {
  const source = await readFile(profilePath, "utf8");
  if (!source.startsWith(EXTENSION_MARKER)) throw new Error("Agent profile is not managed by this installer");
  for (const expected of [
    'model = "deepseek/deepseek-v4-flash"',
    'model_provider = "openai"',
    'model_reasoning_effort = "max"',
  ]) {
    if (!source.includes(expected)) throw new Error(`Agent profile is missing: ${expected}`);
  }
  return "DeepSeek V4 Flash through the existing loopback router at max effort";
});

await check("managedUpdaterCommand", async () => {
  await access(wrapperPath, constants.R_OK | constants.X_OK);
  const source = await readFile(wrapperPath, "utf8");
  if (!source.includes(EXTENSION_MARKER)) throw new Error("Updater wrapper is unmanaged");
  if (!source.includes(resolve(projectRoot, "scripts/update-claude.mjs"))) throw new Error("Updater wrapper points to a stale bundle");
  return wrapperPath;
});

await check("preferClaudeHybrid", async () => {
  await access(preferPath, constants.R_OK | constants.X_OK);
  const source = await readFile(preferPath, "utf8");
  if (!source.includes("# Managed by deepseek-codex-claude-installer.")) throw new Error("Launch Services helper is unmanaged");
  if (!source.includes('OFFICIAL="${HOME}/Applications/Claude Official.app"')) throw new Error("Official source path is stale");
  if (!source.includes('HYBRID="/Applications/Claude.app"')) throw new Error("Hybrid path is stale");
  return preferPath;
});

await check("managedSkills", async () => {
  for (const path of skillPaths) {
    const source = await readFile(path, "utf8");
    if (!source.includes(SKILL_MARKER)) throw new Error(`Skill is unmanaged: ${path}`);
  }
  return skillPaths;
});

await check("claudeHybridSubagents", async () => {
  const hybridConfig = JSON.parse(await readFile(resolve(projectRoot, "claude-hybrid/config/claude-hybrid.json"), "utf8"));
  const agents = renderClaudeHybridAgents(hybridConfig);
  const names = [];
  for (const agent of agents) {
    const path = resolve(home, ".claude/agents", agent.fileName);
    const source = await readFile(path, "utf8");
    if (!source.includes(CLAUDE_AGENT_MARKER)) throw new Error(`Claude agent is unmanaged: ${path}`);
    if (!source.includes(`model: ${JSON.stringify(agent.model)}`)) {
      throw new Error(`Claude agent model is stale: ${path}`);
    }
    if (source.includes("CLAUDE_CODE_SUBAGENT_MODEL") || source.includes("default_subagent")) {
      throw new Error(`Claude Hybrid agents must not change the global subagent default: ${path}`);
    }
    names.push(agent.name);
  }
  return names.join(", ");
});

await check("cursorCliWrappers", async () => {
  const delegateScript = resolve(projectRoot, "scripts/cursor-cli-delegate.mjs");
  const paths = [cursorDelegatePath, ...CURSOR_CLI_MODELS.map((entry) => resolve(home, ".local/bin", entry.commandName))];
  for (const path of paths) {
    await access(path, constants.R_OK | constants.X_OK);
    const source = await readFile(path, "utf8");
    if (!source.includes(EXTENSION_MARKER)) throw new Error(`Cursor CLI wrapper is unmanaged: ${path}`);
    if (!source.includes(delegateScript)) throw new Error(`Cursor CLI wrapper points to a stale bundle: ${path}`);
  }
  return paths;
});

await check("cursorCliSubagents", async () => {
  const names = [];
  for (const agent of renderCursorCliClaudeAgents()) {
    const path = resolve(home, ".claude/agents", agent.fileName);
    const source = await readFile(path, "utf8");
    if (!source.includes(SKILL_MARKER)) throw new Error(`Cursor CLI agent is unmanaged: ${path}`);
    if (!source.includes("$HOME/.local/bin/cursor-cli-delegate")) throw new Error(`Cursor CLI agent does not shell out: ${path}`);
    if (/^model:/m.test(source)) throw new Error(`Cursor CLI agent must inherit and wrap the CLI: ${path}`);
    if (source.includes("CLAUDE_CODE_SUBAGENT_MODEL") || source.includes("default_subagent")) {
      throw new Error(`Cursor CLI agents must not change the global subagent default: ${path}`);
    }
    names.push(agent.name);
  }
  return names.join(", ");
});

await check("cursorCliCommands", async () => {
  const names = [];
  for (const command of renderCursorCliClaudeCommands()) {
    const path = resolve(home, ".claude/commands", command.fileName);
    const source = await readFile(path, "utf8");
    if (!source.includes(SKILL_MARKER)) throw new Error(`Cursor CLI command is unmanaged: ${path}`);
    if (!source.includes(`$HOME/.local/bin/${command.name}`)) {
      throw new Error(`Cursor CLI command does not call the wrapper: ${path}`);
    }
    names.push(command.name);
  }
  return names.join(", ");
});

await check("cursorCliAuth", async () => {
  const result = spawnSync(cursorDelegatePath, ["--check-auth"], {
    encoding: "utf8",
    env: process.env,
    timeout: 20000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Cursor CLI auth check failed");
  const report = JSON.parse(result.stdout);
  if (report.ok !== true || report.authenticated !== true) {
    throw new Error("Cursor CLI is not authenticated; run agent login");
  }
  if (typeof report.email !== "string" || !report.email.includes("@")) {
    throw new Error("Cursor CLI auth did not return an account email");
  }
  return report.email;
});

await check("cursorCliDryRun", async () => {
  const result = spawnSync(cursorDelegatePath, ["--model", "grok-4-6", "--dry-run", "--", "bounded dry-run"], {
    encoding: "utf8",
    env: { ...process.env, CURSOR_API_KEY: "must-not-leak" },
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Cursor CLI dry-run failed");
  const report = JSON.parse(result.stdout);
  if (report.model !== "cursor-grok-4.6-high-fast") throw new Error("Dry-run selected the wrong Grok model");
  if (report.apiKeyPresent !== false) throw new Error("Dry-run leaked CURSOR_API_KEY into the child environment");
  if (!Array.isArray(report.argv) || report.argv.includes("--api-key")) {
    throw new Error("Dry-run must not pass --api-key");
  }
  return report.model;
});

await check("codexCliWrappers", async () => {
  const delegateScript = resolve(projectRoot, "scripts/codex-cli-delegate.mjs");
  const paths = [codexDelegatePath, ...CODEX_CLI_MODELS.map((entry) => resolve(home, ".local/bin", entry.commandName))];
  for (const path of paths) {
    await access(path, constants.R_OK | constants.X_OK);
    const source = await readFile(path, "utf8");
    if (!source.includes(EXTENSION_MARKER)) throw new Error(`Codex CLI wrapper is unmanaged: ${path}`);
    if (!source.includes(delegateScript)) throw new Error(`Codex CLI wrapper points to a stale bundle: ${path}`);
  }
  return paths;
});

await check("codexCliSubagents", async () => {
  const names = [];
  for (const agent of renderCodexCliClaudeAgents()) {
    const path = resolve(home, ".claude/agents", agent.fileName);
    const source = await readFile(path, "utf8");
    if (!source.includes(SKILL_MARKER)) throw new Error(`Codex CLI agent is unmanaged: ${path}`);
    if (!source.includes("$HOME/.local/bin/codex-cli-delegate")) throw new Error(`Codex CLI agent does not shell out: ${path}`);
    if (/^model:/m.test(source)) throw new Error(`Codex CLI agent must inherit and wrap the CLI: ${path}`);
    if (source.includes("Claude Hybrid")) throw new Error(`Codex CLI agent must not use the Hybrid API path: ${path}`);
    names.push(agent.name);
  }
  return names.join(", ");
});

await check("codexCliCommands", async () => {
  const names = [];
  for (const command of renderCodexCliClaudeCommands()) {
    const path = resolve(home, ".claude/commands", command.fileName);
    const source = await readFile(path, "utf8");
    if (!source.includes(SKILL_MARKER)) throw new Error(`Codex CLI command is unmanaged: ${path}`);
    if (!source.includes(`$HOME/.local/bin/${command.name}`)) {
      throw new Error(`Codex CLI command does not call the wrapper: ${path}`);
    }
    names.push(command.name);
  }
  return names.join(", ");
});

await check("codexCliAuth", async () => {
  const result = spawnSync(codexDelegatePath, ["--check-auth"], {
    encoding: "utf8",
    env: process.env,
    timeout: 45000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Codex CLI auth check failed");
  const report = JSON.parse(result.stdout);
  if (report.ok !== true || report.authenticated !== true || report.method !== "chatgpt") {
    throw new Error("Codex CLI is not authenticated with ChatGPT; run codex login");
  }
  return report.method;
});

await check("codexCliDryRun", async () => {
  const result = spawnSync(codexDelegatePath, ["--model", "gpt-5-6-sol", "--dry-run", "--", "bounded dry-run"], {
    encoding: "utf8",
    env: { ...process.env, OPENAI_API_KEY: "must-not-leak", CODEX_API_KEY: "must-not-leak" },
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Codex CLI dry-run failed");
  const report = JSON.parse(result.stdout);
  if (report.model !== "gpt-5.6-sol") throw new Error("Dry-run selected the wrong GPT model");
  if (report.apiKeyPresent !== false) throw new Error("Dry-run leaked an OpenAI API key into the child environment");
  if (!Array.isArray(report.argv) || report.argv.includes("--with-api-key")) {
    throw new Error("Dry-run must not pass --with-api-key");
  }
  if (!report.argv.includes("--ignore-user-config")) {
    throw new Error("Dry-run must ignore user config so ChatGPT subscription is used");
  }
  return report.model;
});

await check("skillDiscovery", async () => {
  const result = spawnSync("codex", ["debug", "prompt-input", "skill discovery check"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "codex prompt rendering failed");
  if (
    !result.stdout.includes("claude-hybrid-update")
    || !result.stdout.includes("deepseek-v4-delegation")
    || !result.stdout.includes("cursor-cli-delegation")
    || !result.stdout.includes("chatgpt-codex-delegation")
  ) {
    throw new Error("Codex did not discover the installed skills");
  }
  return "claude-hybrid-update, deepseek-v4-delegation, cursor-cli-delegation, and chatgpt-codex-delegation appear in the model-visible skill catalog";
});

await check("updaterCheck", async () => {
  const result = spawnSync(process.execPath, [resolve(projectRoot, "scripts/update-claude.mjs"), "--check"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout.trim() || result.stderr.trim() || "updater check failed");
  const report = JSON.parse(result.stdout);
  if (!new Set(["success", "warning"]).has(report.status)) throw new Error("Updater returned an unexpected status");
  return report.summary;
});

const ok = Object.values(checks).every((entry) => entry.ok);
console.log(JSON.stringify({ ok, checks }, null, 2));
if (!ok) process.exitCode = 1;
