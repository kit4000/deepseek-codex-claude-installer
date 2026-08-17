import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  EXTENSION_MARKER,
  SKILL_MARKER,
  patchDeepSeekAgentRegistration,
  renderDeepSeekAgentProfile,
  renderUpdaterWrapper,
} from "../src/extensions.mjs";
import {
  CURSOR_CLI_MODELS,
  renderCursorCliClaudeAgents,
  renderCursorCliClaudeCommands,
  renderCursorCliDelegateWrapper,
  renderCursorCliModelWrapper,
} from "../src/cursor-cli.mjs";
import {
  CODEX_CLI_MODELS,
  canReplaceHybridApiAgent,
  renderCodexCliClaudeAgents,
  renderCodexCliClaudeCommands,
  renderCodexCliDelegateWrapper,
  renderCodexCliModelWrapper,
} from "../src/codex-cli.mjs";
import {
  PREFER_HELPER_MARKER,
  renderPreferClaudeHybrid,
} from "../claude-hybrid/src/app-layout.mjs";
import {
  CLAUDE_AGENT_MARKER,
  renderClaudeHybridAgents,
} from "../claude-hybrid/src/claude-agents.mjs";
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
const claudeAgentsDir = resolve(home, ".claude/agents");
const claudeCommandsDir = resolve(home, ".claude/commands");
const hybridConfig = JSON.parse(await readFile(resolve(projectRoot, "claude-hybrid/config/claude-hybrid.json"), "utf8"));
const claudeAgents = renderClaudeHybridAgents(hybridConfig);
const cursorCliAgents = renderCursorCliClaudeAgents();
const cursorCliCommands = renderCursorCliClaudeCommands();
const codexCliAgents = renderCodexCliClaudeAgents();
const codexCliCommands = renderCodexCliClaudeCommands();
const updaterPath = resolve(projectRoot, "scripts/update-claude.mjs");
const cursorCliDelegateScript = resolve(projectRoot, "scripts/cursor-cli-delegate.mjs");
const codexCliDelegateScript = resolve(projectRoot, "scripts/codex-cli-delegate.mjs");
const skillTargets = [
  ["claude-hybrid-update", resolve(projectRoot, "skills/claude-hybrid-update/SKILL.md"), "codex"],
  ["deepseek-v4-delegation", resolve(projectRoot, "skills/deepseek-v4-delegation/SKILL.md"), "codex"],
  ["cursor-cli-delegation", resolve(projectRoot, "skills/cursor-cli-delegation/SKILL.md"), "both"],
  ["chatgpt-codex-delegation", resolve(projectRoot, "skills/chatgpt-codex-delegation/SKILL.md"), "both"],
];

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

async function writeManaged(path, contents, marker, mode, { replaceHybridApiAgent = false } = {}) {
  const existing = await optionalText(path);
  if (
    existing !== undefined
    && !existing.includes(marker)
    && !(replaceHybridApiAgent && canReplaceHybridApiAgent(existing))
  ) {
    throw new Error(`Refusing to overwrite an unmanaged file: ${path}`);
  }
  await atomicWrite(path, contents, mode);
}

const originalConfig = await readFile(configPath, "utf8");
const patchedConfig = patchDeepSeekAgentRegistration(originalConfig, profilePath);
const profileContents = renderDeepSeekAgentProfile();
const wrapperContents = renderUpdaterWrapper(process.execPath, updaterPath);
const preferContents = renderPreferClaudeHybrid();
const cursorDelegateContents = renderCursorCliDelegateWrapper(process.execPath, cursorCliDelegateScript);
const cursorModelWrappers = CURSOR_CLI_MODELS.map((entry) => ({
  path: resolve(home, ".local/bin", entry.commandName),
  contents: renderCursorCliModelWrapper(process.execPath, cursorCliDelegateScript, entry.alias),
}));
const codexDelegateContents = renderCodexCliDelegateWrapper(process.execPath, codexCliDelegateScript);
const codexModelWrappers = CODEX_CLI_MODELS.map((entry) => ({
  path: resolve(home, ".local/bin", entry.commandName),
  contents: renderCodexCliModelWrapper(process.execPath, codexCliDelegateScript, entry.alias),
}));
const skills = [];
for (const [name, source, scope] of skillTargets) {
  const contents = await readFile(source, "utf8");
  if (!contents.includes(SKILL_MARKER)) throw new Error(`Managed skill marker is missing: ${source}`);
  if (scope === "codex" || scope === "both") {
    skills.push({ target: resolve(codexHome, "skills", name, "SKILL.md"), contents });
  }
  if (scope === "claude" || scope === "both") {
    skills.push({ target: resolve(home, ".claude/skills", name, "SKILL.md"), contents });
  }
}

// Validate every overwrite boundary before making the first managed write.
for (const [path, marker] of [
  [profilePath, EXTENSION_MARKER],
  [wrapperPath, EXTENSION_MARKER],
  [preferPath, PREFER_HELPER_MARKER],
  [cursorDelegatePath, EXTENSION_MARKER],
  [codexDelegatePath, EXTENSION_MARKER],
  ...cursorModelWrappers.map((wrapper) => [wrapper.path, EXTENSION_MARKER]),
  ...codexModelWrappers.map((wrapper) => [wrapper.path, EXTENSION_MARKER]),
  ...skills.map(({ target }) => [target, SKILL_MARKER]),
  ...claudeAgents.map((agent) => [resolve(claudeAgentsDir, agent.fileName), CLAUDE_AGENT_MARKER]),
  ...cursorCliAgents.map((agent) => [resolve(claudeAgentsDir, agent.fileName), SKILL_MARKER]),
  ...cursorCliCommands.map((command) => [resolve(claudeCommandsDir, command.fileName), SKILL_MARKER]),
  ...codexCliCommands.map((command) => [resolve(claudeCommandsDir, command.fileName), SKILL_MARKER]),
]) {
  const existing = await optionalText(path);
  if (existing !== undefined && !existing.includes(marker)) {
    throw new Error(`Refusing to overwrite an unmanaged file: ${path}`);
  }
}
for (const agent of codexCliAgents) {
  const path = resolve(claudeAgentsDir, agent.fileName);
  const existing = await optionalText(path);
  if (
    existing !== undefined
    && !existing.includes(SKILL_MARKER)
    && !canReplaceHybridApiAgent(existing)
  ) {
    throw new Error(`Refusing to overwrite an unmanaged file: ${path}`);
  }
}

let backupPath = null;
if (patchedConfig !== originalConfig) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  backupPath = `${configPath}.before-deepseek-agent.${timestamp}.bak`;
  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
}

await writeManaged(profilePath, profileContents, EXTENSION_MARKER, 0o600);
await writeManaged(wrapperPath, wrapperContents, EXTENSION_MARKER, 0o700);
await writeManaged(preferPath, preferContents, PREFER_HELPER_MARKER, 0o700);
await writeManaged(cursorDelegatePath, cursorDelegateContents, EXTENSION_MARKER, 0o700);
for (const wrapper of cursorModelWrappers) {
  await writeManaged(wrapper.path, wrapper.contents, EXTENSION_MARKER, 0o700);
}
await writeManaged(codexDelegatePath, codexDelegateContents, EXTENSION_MARKER, 0o700);
for (const wrapper of codexModelWrappers) {
  await writeManaged(wrapper.path, wrapper.contents, EXTENSION_MARKER, 0o700);
}

const installedSkills = [];
for (const { target, contents } of skills) {
  await writeManaged(target, contents, SKILL_MARKER, 0o600);
  installedSkills.push(target);
}
const installedClaudeAgents = [];
for (const agent of claudeAgents) {
  const target = resolve(claudeAgentsDir, agent.fileName);
  await writeManaged(target, agent.contents, CLAUDE_AGENT_MARKER, 0o600);
  installedClaudeAgents.push(target);
}
const installedCursorCliAgents = [];
for (const agent of cursorCliAgents) {
  const target = resolve(claudeAgentsDir, agent.fileName);
  await writeManaged(target, agent.contents, SKILL_MARKER, 0o600);
  installedCursorCliAgents.push(target);
}
const installedCursorCliCommands = [];
for (const command of cursorCliCommands) {
  const target = resolve(claudeCommandsDir, command.fileName);
  await writeManaged(target, command.contents, SKILL_MARKER, 0o600);
  installedCursorCliCommands.push(target);
}
const installedCodexCliAgents = [];
for (const agent of codexCliAgents) {
  const target = resolve(claudeAgentsDir, agent.fileName);
  await writeManaged(target, agent.contents, SKILL_MARKER, 0o600, { replaceHybridApiAgent: true });
  installedCodexCliAgents.push(target);
}
const installedCodexCliCommands = [];
for (const command of codexCliCommands) {
  const target = resolve(claudeCommandsDir, command.fileName);
  await writeManaged(target, command.contents, SKILL_MARKER, 0o600);
  installedCodexCliCommands.push(target);
}
if (patchedConfig !== originalConfig) await atomicWrite(configPath, patchedConfig, 0o600);

console.log(JSON.stringify({
  status: "success",
  summary: "Claude Hybrid extras, Launch Services helpers, skills, callable subagents, Cursor CLI wrappers, and ChatGPT Codex CLI wrappers were installed.",
  next_actions: [
    "Restart Codex Desktop so the new skills and deepseek-v4 agent type are loaded.",
    "Use update-claude-hybrid --check before update-claude-hybrid --apply.",
    "Use prefer-claude-hybrid if Launch Services ever selects Claude Official.app.",
    "Invoke Claude Code agents deepseek-v4-flash or deepseek-v4-pro only when billable delegation is intended.",
    "Invoke agent_type deepseek-v4 only for explicitly requested or approved billable delegation.",
    "Run cursor-cli-delegate --check-auth, then cursor-grok-4-6 or cursor-composer-2-5 for Cursor subscription models.",
    "Run codex-cli-delegate --check-auth, then gpt-5-6-sol or gpt-5-6-luna for ChatGPT subscription models.",
    "In Claude Code, start a new session and use /cursor-grok-4-6, /cursor-composer-2-5, /gpt-5-6-sol, or /gpt-5-6-luna.",
  ],
  artifacts: {
    configPath,
    backupPath,
    profilePath,
    wrapperPath,
    preferPath,
    cursorDelegatePath,
    cursorModelWrappers: cursorModelWrappers.map((wrapper) => wrapper.path),
    codexDelegatePath,
    codexModelWrappers: codexModelWrappers.map((wrapper) => wrapper.path),
    installedSkills,
    installedClaudeAgents,
    installedCursorCliAgents,
    installedCursorCliCommands,
    installedCodexCliAgents,
    installedCodexCliCommands,
  },
}, null, 2));
