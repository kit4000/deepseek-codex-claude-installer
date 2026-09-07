import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaudeConfig } from "../src/claude-config.mjs";
import {
  CODEX_ROUTER_BASE_URL,
  findCodexDesktopLocalRouterConflicts,
  findGlobalClaudeDeepSeekSettings,
  findShellDeepSeekExports,
  inspectCodexConfig,
  inspectRouterHealth,
  validateClaudeDesktopTemplate,
  validateRouterForHandoff,
} from "../src/handoff.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const codexHome = process.env.CODEX_HOME ?? resolve(home, ".codex");
const binDirectory = resolve(process.env.DEEPSEEK_BIN_DIR ?? resolve(home, ".local/bin"));
const catalogPath = resolve(codexHome, "model-catalogs/native-plus-external.json");
const scope = process.env.DEEPSEEK_VERIFY_SCOPE ?? "all";
const includeClaudeCode = scope !== "codex";
const results = [];

function result(name, status, detail) {
  results.push({ name, status, detail });
}

async function verify(name, action) {
  try {
    const detail = await action();
    result(name, "pass", detail ?? "ok");
  } catch (error) {
    result(name, "fail", error.message);
  }
}

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

await verify("router source configuration", async () => {
  validateRouterForHandoff(JSON.parse(await readFile(resolve(projectRoot, "router-config.json"), "utf8")));
  return "display stabilizers and official endpoints are enabled";
});

await verify("Codex root configuration", async () => {
  const source = await readFile(resolve(codexHome, "config.toml"), "utf8");
  const failed = inspectCodexConfig(source, {
    catalogPath,
    routerBaseUrl: CODEX_ROUTER_BASE_URL,
    defaultModel: "deepseek/deepseek-v4-flash",
    requireExternalMigrationDisabled: true,
  }).filter((entry) => !entry.ok);
  if (failed.length > 0) throw new Error(`Unexpected settings: ${failed.map((entry) => entry.name).join(", ")}`);
  return "openai provider identity, merged catalog, loopback router, and uncompressed requests";
});

await verify("merged Codex model catalog", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("Model catalog is empty");
  const flash = catalog.models.find((entry) => entry.slug === "deepseek/deepseek-v4-flash");
  if (!flash) throw new Error("DeepSeek V4 Flash is missing from the Codex model catalog");
  if (flash.priority !== 0) throw new Error("DeepSeek V4 Flash must have priority 0");
  if (catalog.models.some((entry) => /pending|not enabled/i.test(`${entry.display_name ?? ""} ${entry.description ?? ""}`))) {
    throw new Error("Pending models must not be exposed in the Codex model catalog");
  }
  if (!catalog.models.some((entry) => !entry.slug?.startsWith("deepseek/"))) {
    throw new Error("Native Codex models are missing from the merged catalog");
  }
  return `${catalog.models.length} models including native and DeepSeek entries`;
});

await verify("Codex Desktop execution target", async () => {
  const state = JSON.parse(await readFile(resolve(codexHome, ".codex-global-state.json"), "utf8"));
  const conflicts = findCodexDesktopLocalRouterConflicts(state);
  if (conflicts.length > 0) {
    throw new Error("A remote project is selected; choose a local project before using the local DeepSeek router");
  }
  return "selected project is local or unset";
});

await verify("DeepSeek Codex profile", async () => {
  const source = await readFile(resolve(codexHome, "deepseek.config.toml"), "utf8");
  if (!source.startsWith("# Managed by codex-native-model-router.")) throw new Error("Profile is not managed by this bundle");
  if (!source.includes('model = "deepseek/deepseek-v4-flash"')) throw new Error("Unexpected DeepSeek profile model");
  if (!source.includes('model_provider = "openai"')) throw new Error("Profile changed the built-in provider identity");
  return "managed profile present";
});

await verify("automatic router startup", async () => {
  const launchAgentPath = resolve(home, "Library/LaunchAgents/com.local.codex-native-model-router.plist");
  const source = await optionalText(launchAgentPath);
  if (source !== undefined) {
    if (!source.includes(resolve(projectRoot, "src/router.mjs"))) throw new Error("LaunchAgent points to a different bundle path");
    if (!source.includes(resolve(projectRoot, "router-config.json"))) throw new Error("LaunchAgent points to a different router config");
    return launchAgentPath;
  }

  const appInfoPath = resolve(home, "Applications/Codex Native Model Router.app/Contents/Info.plist");
  const appInfo = await readFile(appInfoPath, "utf8");
  if (!appInfo.includes("com.local.codex-native-model-router")) throw new Error("Router app has an unexpected bundle identifier");
  if (!appInfo.includes("NSLocalNetworkUsageDescription")) throw new Error("Router app is missing its local network permission description");
  await access(resolve(home, ".local/bin/codex-router-watchdog.sh"), constants.R_OK | constants.X_OK);
  return resolve(home, "Applications/Codex Native Model Router.app");
});

await verify("router health", async () => {
  const response = await fetch("http://127.0.0.1:10100/healthz", { signal: AbortSignal.timeout(1000) });
  const health = response.ok ? await response.json() : undefined;
  if (!inspectRouterHealth(health)) throw new Error("Expected DeepSeek router health payload was not returned");
  return "openai provider with deepseek route";
});

if (includeClaudeCode) {
  await verify("Claude Code configuration", async () => {
    validateClaudeConfig(JSON.parse(await readFile(resolve(projectRoot, "config/claude-deepseek.json"), "utf8")));
    return "official DeepSeek Anthropic endpoint";
  });

  await verify("Claude DeepSeek launcher", async () => {
    const path = resolve(binDirectory, "claude-deepseek");
    await access(path, constants.R_OK | constants.X_OK);
    const source = await readFile(path, "utf8");
    if (!source.includes("# Managed by deepseek-handoff.")) throw new Error("Launcher is not managed by this bundle");
    if (!source.includes(resolve(projectRoot, "scripts/claude-deepseek.mjs"))) throw new Error("Launcher points to a different bundle path");
    return path;
  });

  await verify("Claude Desktop template", async () => {
    validateClaudeDesktopTemplate(JSON.parse(
      await readFile(resolve(projectRoot, "config/claude-desktop-gateway.template.json"), "utf8"),
    ));
    return "contains a placeholder rather than a real credential";
  });
}

await verify("native Claude provider isolation", async () => {
  const settingsText = await optionalText(resolve(home, ".claude/settings.json"));
  const settings = settingsText === undefined ? {} : JSON.parse(settingsText);
  const findings = findGlobalClaudeDeepSeekSettings(settings, process.env);
  for (const name of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"]) {
    const path = resolve(home, name);
    const source = await optionalText(path);
    if (source !== undefined) findings.push(...findShellDeepSeekExports(source, path));
  }
  const uniqueFindings = [...new Set(findings)].sort();
  if (uniqueFindings.length > 0) throw new Error(`Global DeepSeek settings found: ${uniqueFindings.join(", ")}`);
  return "normal claude settings and session directory are unchanged";
});

await verify("DeepSeek credential", () => {
  const credential = spawnSync("/usr/bin/security", [
    "find-generic-password",
    "-s", "com.local.codex-native-model-router.deepseek",
    "-a", "api-key",
    "-w",
  ], { stdio: "ignore", timeout: 5000 });
  if (credential.status !== 0) throw new Error("DeepSeek API key is missing from macOS Keychain");
  return "present in macOS Keychain (value not displayed)";
});

console.log(JSON.stringify({ ok: !results.some((entry) => entry.status === "fail"), results }, null, 2));
if (results.some((entry) => entry.status === "fail")) process.exitCode = 1;
