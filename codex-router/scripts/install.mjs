import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchCodexConfig } from "../src/lib.mjs";
import { generateCatalog } from "./generate-catalog.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
const configPath = resolve(codexHome, "config.toml");
const routerConfigPath = resolve(projectRoot, "router-config.json");
const catalogPath = resolve(codexHome, "model-catalogs/native-plus-external.json");
const routerBaseUrl = "http://127.0.0.1:10100/v1";
const label = "com.local.codex-native-model-router";
const launchAgentsDirectory = resolve(process.env.HOME, "Library/LaunchAgents");
const launchAgentPath = resolve(launchAgentsDirectory, `${label}.plist`);
const profileMarker = "# Managed by codex-native-model-router.";

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function launchAgentPlist() {
  const args = [process.execPath, resolve(projectRoot, "src/router.mjs")]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_MODEL_ROUTER_CONFIG</key>
    <string>${xmlEscape(routerConfigPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/codex-native-model-router.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codex-native-model-router.err.log</string>
</dict>
</plist>
`;
}

async function atomicWrite(path, contents, mode) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, { mode });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

async function waitForHealth(expectedRoutes) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:10100/healthz", { signal: AbortSignal.timeout(500) });
      const health = response.ok ? await response.json() : undefined;
      if (
        health?.ok === true
        && health.provider === "openai"
        && expectedRoutes.every((route) => health.routes?.includes(route))
      ) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Expected DeepSeek router did not become healthy; config.toml was not changed");
}

async function writeProfile(profile) {
  if (!profile?.name || !profile?.model) return undefined;
  const profilePath = resolve(codexHome, `${profile.name}.config.toml`);
  let existing = "";
  try {
    existing = await readFile(profilePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && !existing.startsWith(profileMarker)) {
    throw new Error(`Refusing to overwrite unmanaged profile: ${profilePath}`);
  }
  const contents = [
    profileMarker,
    `model = ${JSON.stringify(profile.model)}`,
    'model_provider = "openai"',
    "",
  ].join("\n");
  await atomicWrite(profilePath, contents, 0o600);
  return profilePath;
}

async function main() {
  await access(configPath, constants.R_OK | constants.W_OK);
  const routerConfig = JSON.parse(await readFile(routerConfigPath, "utf8"));
  const catalog = await generateCatalog({ codexHome, routerConfigPath, outputPath: catalogPath });

  await mkdir(launchAgentsDirectory, { recursive: true });
  await atomicWrite(launchAgentPath, launchAgentPlist(), 0o644);
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, launchAgentPath], { stdio: "ignore" });
  const bootstrap = spawnSync("launchctl", ["bootstrap", domain, launchAgentPath], { encoding: "utf8" });
  if (bootstrap.status !== 0) throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);
  spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
  await waitForHealth((routerConfig.routes ?? []).map((route) => route.namespace));

  // config.toml is backed up immediately before its first write.
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = `${configPath}.before-model-router.${timestamp}.bak`;
  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);

  const originalConfig = await readFile(configPath, "utf8");
  const patchedConfig = patchCodexConfig(originalConfig, {
    catalogPath,
    routerBaseUrl,
    routes: routerConfig.routes,
    removeSections: routerConfig.configMigration?.removeSections,
    profile: routerConfig.configMigration?.profile,
  });
  const profilePath = await writeProfile(routerConfig.configMigration?.profile);
  await atomicWrite(configPath, patchedConfig, 0o600);
  console.log(JSON.stringify({
    backupPath,
    catalogPath,
    launchAgentPath,
    profilePath,
    ...catalog,
    modelProvider: "openai",
    routerBaseUrl,
  }));
}

await main();
