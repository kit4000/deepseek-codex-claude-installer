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
  PREFER_HELPER_MARKER,
  renderPreferClaudeHybrid,
} from "../claude-hybrid/src/app-layout.mjs";
import { projectRoot } from "./lib.mjs";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const codexHome = process.env.CODEX_HOME ?? resolve(home, ".codex");
const configPath = resolve(codexHome, "config.toml");
const profilePath = resolve(codexHome, "agent-profiles/deepseek-v4.toml");
const wrapperPath = resolve(home, ".local/bin/update-claude-hybrid");
const preferPath = resolve(home, ".local/bin/prefer-claude-hybrid");
const updaterPath = resolve(projectRoot, "scripts/update-claude.mjs");
const skillTargets = [
  ["claude-hybrid-update", resolve(projectRoot, "skills/claude-hybrid-update/SKILL.md")],
  ["deepseek-v4-delegation", resolve(projectRoot, "skills/deepseek-v4-delegation/SKILL.md")],
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

async function writeManaged(path, contents, marker, mode) {
  const existing = await optionalText(path);
  if (existing !== undefined && !existing.includes(marker)) {
    throw new Error(`Refusing to overwrite an unmanaged file: ${path}`);
  }
  await atomicWrite(path, contents, mode);
}

const originalConfig = await readFile(configPath, "utf8");
const patchedConfig = patchDeepSeekAgentRegistration(originalConfig, profilePath);
const profileContents = renderDeepSeekAgentProfile();
const wrapperContents = renderUpdaterWrapper(process.execPath, updaterPath);
const preferContents = renderPreferClaudeHybrid();
const skills = [];
for (const [name, source] of skillTargets) {
  const target = resolve(codexHome, "skills", name, "SKILL.md");
  const contents = await readFile(source, "utf8");
  if (!contents.includes(SKILL_MARKER)) throw new Error(`Managed skill marker is missing: ${source}`);
  skills.push({ target, contents });
}

// Validate every overwrite boundary before making the first managed write.
for (const [path, marker] of [
  [profilePath, EXTENSION_MARKER],
  [wrapperPath, EXTENSION_MARKER],
  [preferPath, PREFER_HELPER_MARKER],
  ...skills.map(({ target }) => [target, SKILL_MARKER]),
]) {
  const existing = await optionalText(path);
  if (existing !== undefined && !existing.includes(marker)) {
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

const installedSkills = [];
for (const { target, contents } of skills) {
  await writeManaged(target, contents, SKILL_MARKER, 0o600);
  installedSkills.push(target);
}
if (patchedConfig !== originalConfig) await atomicWrite(configPath, patchedConfig, 0o600);

console.log(JSON.stringify({
  status: "success",
  summary: "Claude Hybrid update and Launch Services helpers, skills, and the DeepSeek V4 callable subagent were installed.",
  next_actions: [
    "Restart Codex Desktop so the new skills and deepseek-v4 agent type are loaded.",
    "Use update-claude-hybrid --check before update-claude-hybrid --apply.",
    "Use prefer-claude-hybrid if Launch Services ever selects Claude Official.app.",
    "Invoke agent_type deepseek-v4 only for explicitly requested or approved billable delegation.",
  ],
  artifacts: { configPath, backupPath, profilePath, wrapperPath, preferPath, installedSkills },
}, null, 2));
