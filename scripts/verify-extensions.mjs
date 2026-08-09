import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EXTENSION_MARKER, SKILL_MARKER } from "../src/extensions.mjs";
import { projectRoot } from "./lib.mjs";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const codexHome = process.env.CODEX_HOME ?? resolve(home, ".codex");
const configPath = resolve(codexHome, "config.toml");
const profilePath = resolve(codexHome, "agent-profiles/deepseek-v4.toml");
const wrapperPath = resolve(home, ".local/bin/update-claude-hybrid");
const preferPath = resolve(home, ".local/bin/prefer-claude-hybrid");
const skillPaths = [
  resolve(codexHome, "skills/claude-hybrid-update/SKILL.md"),
  resolve(codexHome, "skills/deepseek-v4-delegation/SKILL.md"),
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

await check("skillDiscovery", async () => {
  const result = spawnSync("codex", ["debug", "prompt-input", "skill discovery check"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "codex prompt rendering failed");
  if (!result.stdout.includes("claude-hybrid-update") || !result.stdout.includes("deepseek-v4-delegation")) {
    throw new Error("Codex did not discover both installed skills");
  }
  return "both skills appear in the model-visible skill catalog";
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
