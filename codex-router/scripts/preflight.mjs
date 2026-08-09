import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaudeConfig } from "../src/claude-config.mjs";
import {
  findGlobalClaudeDeepSeekSettings,
  findShellDeepSeekExports,
  inspectRouterHealth,
  validateClaudeDesktopTemplate,
  validateRouterForHandoff,
} from "../src/handoff.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const codexHome = process.env.CODEX_HOME ?? resolve(home, ".codex");
const scope = process.env.DEEPSEEK_PREFLIGHT_SCOPE ?? "all";
const includeClaudeCode = scope !== "codex";
const results = [];

function result(name, status, detail) {
  results.push({ name, status, detail });
}

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function check(name, action) {
  try {
    const detail = await action();
    result(name, "pass", detail ?? "ok");
  } catch (error) {
    result(name, "fail", error.message);
  }
}

await check("platform", () => {
  if (process.platform !== "darwin") throw new Error("This Keychain and LaunchAgent handoff currently supports macOS only");
  return "macOS";
});

await check("Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20 or later is required (found ${process.versions.node})`);
  return process.versions.node;
});

await check("permanent bundle path", () => {
  if (projectRoot.startsWith("/tmp/") || projectRoot.startsWith("/private/tmp/")) {
    throw new Error("Move the bundle out of the temporary directory before installation");
  }
  return projectRoot;
});

await check("router configuration", async () => {
  validateRouterForHandoff(JSON.parse(await readFile(resolve(projectRoot, "router-config.json"), "utf8")));
  return "official endpoints, Keychain auth, and display stabilizers validated";
});

if (includeClaudeCode) {
  await check("Claude Code configuration", async () => {
    validateClaudeConfig(JSON.parse(await readFile(resolve(projectRoot, "config/claude-deepseek.json"), "utf8")));
    return "official Anthropic-compatible endpoint validated";
  });

  await check("Claude Desktop template", async () => {
    validateClaudeDesktopTemplate(JSON.parse(
      await readFile(resolve(projectRoot, "config/claude-desktop-gateway.template.json"), "utf8"),
    ));
    return "secret-free gateway template validated";
  });
}

await check("Codex configuration", async () => {
  await access(resolve(codexHome, "config.toml"), constants.R_OK | constants.W_OK);
  return resolve(codexHome, "config.toml");
});

await check("Codex native catalog source", async () => {
  const candidates = [
    resolve(codexHome, "model-catalogs/native-pristine.json"),
    resolve(codexHome, "models_cache.json"),
  ];
  for (const path of candidates) {
    try {
      await access(path, constants.R_OK);
      return path;
    } catch {}
  }
  throw new Error("Launch Codex Desktop once so models_cache.json is created");
});

if (includeClaudeCode) {
  await check("Claude Code executable", () => {
    const executable = process.env.DEEPSEEK_CLAUDE_BIN ?? "claude";
    if (/(^|\/)claude-deepseek$/.test(executable)) {
      throw new Error("DEEPSEEK_CLAUDE_BIN must point to the original Claude Code executable");
    }
    const located = executable.includes("/")
      ? spawnSync("/bin/test", ["-x", executable])
      : spawnSync("/usr/bin/which", [executable], { encoding: "utf8" });
    if (located.status !== 0) throw new Error("Install the official Claude Code command before continuing");
    return executable.includes("/") ? executable : located.stdout.trim();
  });
}

await check("native Claude provider isolation", async () => {
  const settingsPath = resolve(home, ".claude/settings.json");
  const settingsText = await optionalText(settingsPath);
  let settings = {};
  if (settingsText !== undefined) settings = JSON.parse(settingsText);
  const findings = findGlobalClaudeDeepSeekSettings(settings, process.env);
  const shellFiles = [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"];
  for (const name of shellFiles) {
    const path = resolve(home, name);
    const source = await optionalText(path);
    if (source !== undefined) findings.push(...findShellDeepSeekExports(source, path));
  }
  const uniqueFindings = [...new Set(findings)].sort();
  if (uniqueFindings.length > 0) {
    throw new Error(`Remove global DeepSeek exports before installing: ${uniqueFindings.join(", ")}`);
  }
  return "normal claude remains on its existing provider";
});

try {
  const response = await fetch("http://127.0.0.1:10100/healthz", { signal: AbortSignal.timeout(750) });
  const health = response.ok ? await response.json() : undefined;
  if (!inspectRouterHealth(health)) {
    result("router port", "fail", "port 10100 is occupied by an unexpected service");
  } else {
    result("router port", "pass", "expected DeepSeek router is already running");
  }
} catch {
  result("router port", "warn", "router is not running yet; installer will start it");
}

const credential = spawnSync("/usr/bin/security", [
  "find-generic-password",
  "-s", "com.local.codex-native-model-router.deepseek",
  "-a", "api-key",
  "-w",
], { stdio: "ignore", timeout: 5000 });
result(
  "DeepSeek credential",
  credential.status === 0 ? "pass" : "warn",
  credential.status === 0 ? "present in macOS Keychain" : "not stored yet; run npm run store-deepseek-key",
);

console.log(JSON.stringify({ ok: !results.some((entry) => entry.status === "fail"), results }, null, 2));
if (results.some((entry) => entry.status === "fail")) process.exitCode = 1;
