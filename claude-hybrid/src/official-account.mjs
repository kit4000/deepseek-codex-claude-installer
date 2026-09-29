import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

function gatewayLooksLikeDeepSeek(url) {
  return typeof url === "string" && url.toLowerCase().includes("deepseek");
}

export function isManagedDeepSeekOnlyLibrary(configs) {
  if (!Array.isArray(configs) || configs.length === 0) return false;
  return configs.every((config) =>
    config
    && typeof config === "object"
    && !Array.isArray(config)
    && config.inferenceGatewayBaseUrl === DEEPSEEK_ANTHROPIC_BASE_URL);
}

export function libraryHasDeepSeekGateway(configs) {
  if (!Array.isArray(configs) || configs.length === 0) return false;
  return configs.some((config) =>
    config
    && typeof config === "object"
    && !Array.isArray(config)
    && gatewayLooksLikeDeepSeek(config.inferenceGatewayBaseUrl));
}

export function firstPartyDesktopConfig(desktopConfig) {
  if (!desktopConfig || typeof desktopConfig !== "object" || Array.isArray(desktopConfig)) {
    throw new Error("Claude desktop config must be an object");
  }
  if (desktopConfig.deploymentMode !== "3p") return null;
  return { ...desktopConfig, deploymentMode: "1p" };
}

async function readLibraryConfigs(libraryDir) {
  let names;
  try {
    names = await readdir(libraryDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const configs = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "_meta.json") continue;
    configs.push(JSON.parse(await readFile(join(libraryDir, name), "utf8")));
  }
  return configs;
}

/**
 * Move Claude Desktop out of the managed DeepSeek-only 3P gateway so Official
 * (Cloud.app) uses the normal first-party Anthropic account again.
 *
 * Options:
 * - forceFirstParty: when true, any deploymentMode "3p" is switched to "1p"
 *   (used by restore-official-normal after the user asked for stock Official).
 *   Without force, only managed DeepSeek-only libraries are eligible.
 */
export async function releaseDeepSeekOnlyOfficialAccount(home, { forceFirstParty = false } = {}) {
  if (!home) throw new Error("HOME is required");
  const support = join(home, "Library/Application Support/Claude-3p");
  const configPath = join(support, "claude_desktop_config.json");
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { changed: false, reason: "absent" };
    throw error;
  }
  const desktopConfig = JSON.parse(raw);
  if (desktopConfig?.deploymentMode !== "3p") {
    return { changed: false, reason: "already-first-party", configPath };
  }
  const configs = await readLibraryConfigs(join(support, "configLibrary"));
  const managedDeepSeekOnly = isManagedDeepSeekOnlyLibrary(configs);
  const hasDeepSeekGateway = libraryHasDeepSeekGateway(configs);
  if (!forceFirstParty && !managedDeepSeekOnly) {
    return {
      changed: false,
      reason: hasDeepSeekGateway ? "mixed-or-partial-deepseek-3p" : "unmanaged-3p",
      configPath,
      hasDeepSeekGateway,
    };
  }
  if (forceFirstParty && !managedDeepSeekOnly && !hasDeepSeekGateway && configs.length > 0) {
    // force still applies: user asked for normal Official; keep a clear reason.
  }
  const next = firstPartyDesktopConfig(desktopConfig);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const backupPath = `${configPath}.before-first-party-${timestamp}`;
  await writeFile(backupPath, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return {
    changed: true,
    configPath,
    backupPath,
    deploymentMode: "1p",
    forced: forceFirstParty,
    managedDeepSeekOnly,
    hasDeepSeekGateway,
  };
}
