import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchClaudeApp } from "../src/app-patch.mjs";
import { readAsarFile, readAsarHeader } from "../src/asar-repack.mjs";
import { requestUnix } from "../src/router.mjs";
import {
  PREFER_HELPER_MARKER,
  hasHybridMarker,
  inspectAppleSignature,
  isDefaultClaudeLayout,
  pathExists,
  preferClaudeHybrid,
  prepareClaudeAppLayout,
  readManagedHelper,
  renderPreferClaudeHybrid,
} from "../src/app-layout.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);

const sourceApp = process.env.CLAUDE_HYBRID_SOURCE ?? expand(config.app.source);
const targetApp = process.env.CLAUDE_HYBRID_TARGET ?? expand(config.app.target);
const managedDir = process.env.CLAUDE_HYBRID_RUNTIME_DIR ?? `${home}/Library/Application Support/Claude Hybrid`;
const launchAgentsDir = `${home}/Library/LaunchAgents`;
const plistPath = join(launchAgentsDir, `${config.launchAgent.label}.plist`);
const logDirectory = expand(config.launchAgent.logDirectory);
const routerPath = join(managedDir, "router.mjs");
const runtimeConfigPath = join(managedDir, "config.json");
const helperPath = expand(config.deepseek.credentialHelper);
const openaiHelperPath = config.openai?.credentialHelper
  ? expand(config.openai.credentialHelper)
  : undefined;
const preferHelperPath = `${home}/.local/bin/prefer-claude-hybrid`;
const routerBaseUrl = expand(config.app.routerBaseUrl);
const routerSocketPath = expand(config.router.socketPath);
const domain = `gui/${process.getuid()}`;
const label = config.launchAgent.label;

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function renderCredentialHelper(keychain) {
  const { service, account } = keychain;
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Managed by claude-hybrid. Rerun npm run install after moving the bundle.",
    `exec security find-generic-password -s ${quote(service)} -a ${quote(account)} -w`,
    "",
  ].join("\n");
}

function renderLaunchAgentPlist(nodePath, routerPath, runtimeConfigPath, logDirectory) {
  const entries = [nodePath, routerPath].map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${entries}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(dirname(routerPath))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_HYBRID_CONFIG</key>
    <string>${xmlEscape(runtimeConfigPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDirectory, "router.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDirectory, "router.err.log"))}</string>
</dict>
</plist>
`;
}

async function waitForHealth(port, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      const health = response.ok ? await response.json() : undefined;
      if (health?.ok === true && health.provider === "claude-hybrid") return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Claude Hybrid router did not become healthy");
}

async function waitForUnix(socketPath, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await requestUnix(socketPath, { path: "/healthz", timeoutMs: 500 });
      if (result.statusCode === 200) {
        const health = JSON.parse(result.body.toString("utf8"));
        if (health?.ok === true && health.provider === "claude-hybrid") return;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Claude Hybrid router unix socket did not become healthy");
}

const keyResult = run("/usr/bin/security", [
  "find-generic-password",
  "-s", config.deepseek.keychain.service,
  "-a", config.deepseek.keychain.account,
  "-w",
], { timeout: 5000 });
if (keyResult.status !== 0 || !keyResult.stdout?.trim()) {
  throw new Error("DeepSeek API key is missing from macOS Keychain; run npm run store-deepseek-key first");
}
const openaiRequired = (config.models?.external ?? []).some((entry) => entry.provider === "openai");
if (openaiRequired) {
  if (!config.openai?.keychain?.service || !config.openai?.keychain?.account || !openaiHelperPath) {
    throw new Error("OpenAI provider models are configured but no OpenAI keychain exists; remove those models instead of storing an API key");
  }
  const openaiKeyResult = run("/usr/bin/security", [
    "find-generic-password",
    "-s", config.openai.keychain.service,
    "-a", config.openai.keychain.account,
    "-w",
  ], { timeout: 5000 });
  if (openaiKeyResult.status !== 0 || !openaiKeyResult.stdout?.trim()) {
    throw new Error("OpenAI provider models are configured but no OpenAI keychain credential exists; remove those models instead of storing an API key");
  }
}

const running = run("/usr/bin/pgrep", ["-x", "Claude"]);
if (running.status === 0) {
  throw new Error("Claude is running; ask the user to fully quit Claude before installing or updating Hybrid");
}

let existingHelper = "";
try {
  existingHelper = await readFile(helperPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const helperIsManaged =
  existingHelper.includes("# Managed by claude-hybrid.")
  || existingHelper.includes("# Managed by deepseek-handoff.");
if (existingHelper && !helperIsManaged) {
  throw new Error(`Refusing to overwrite an unmanaged executable: ${helperPath}`);
}

let existingOpenAIHelper = "";
if (openaiRequired) {
  try {
    existingOpenAIHelper = await readFile(openaiHelperPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existingOpenAIHelper && !existingOpenAIHelper.includes("# Managed by claude-hybrid.")) {
    throw new Error(`Refusing to overwrite an unmanaged executable: ${openaiHelperPath}`);
  }
}

const existingPreferHelper = await readManagedHelper(preferHelperPath);
if (existingPreferHelper && !existingPreferHelper.includes(PREFER_HELPER_MARKER)) {
  throw new Error(`Refusing to overwrite an unmanaged executable: ${preferHelperPath}`);
}

const defaultLayout = isDefaultClaudeLayout({ sourceApp, targetApp, home });
const targetCanBecomeOfficial = defaultLayout
  && await pathExists(targetApp)
  && !hasHybridMarker(targetApp)
  && inspectAppleSignature(targetApp).ok;
const inspectionSource = targetCanBecomeOfficial ? targetApp : sourceApp;
const inspectionAsar = join(inspectionSource, "Contents/Resources/app.asar");
const environmentSource = await readAsarFile(inspectionAsar, config.app.patchFile);
const labelSource = await readAsarFile(inspectionAsar, config.app.modelLabelPatchFile);
if (!environmentSource?.includes(config.app.patchFrom)) {
  throw new Error(`Claude Code environment anchor is absent in ${config.app.patchFile}; stop instead of fuzzy-patching`);
}
if (!labelSource?.includes(config.app.modelLabelPatchFrom)) {
  throw new Error(`Claude picker anchor is absent in ${config.app.modelLabelPatchFile}; stop instead of fuzzy-patching`);
}

const layout = await prepareClaudeAppLayout({ sourceApp, targetApp, home });

await mkdir(managedDir, { recursive: true });
await mkdir(logDirectory, { recursive: true });

for (const moduleName of ["router.mjs", "openai-messages.mjs"]) {
  await writeFile(join(managedDir, moduleName), await readFile(resolve(projectRoot, "src", moduleName), "utf8"), { mode: 0o700 });
}

const runtimeConfig = structuredClone(config);
runtimeConfig.app.target = targetApp;
runtimeConfig.app.source = sourceApp;
runtimeConfig.app.routerBaseUrl = routerBaseUrl;
runtimeConfig.router.socketPath = routerSocketPath;
runtimeConfig.deepseek.credentialHelper = helperPath;
if (openaiHelperPath) {
  runtimeConfig.openai = runtimeConfig.openai ?? {};
  runtimeConfig.openai.credentialHelper = openaiHelperPath;
} else {
  delete runtimeConfig.openai;
}
runtimeConfig.launchAgent.plistPath = plistPath;
runtimeConfig.launchAgent.logDirectory = logDirectory;
await writeFile(runtimeConfigPath, JSON.stringify(runtimeConfig, null, 2), { mode: 0o600 });

await mkdir(dirname(helperPath), { recursive: true });
const helperTemporaryPath = `${helperPath}.tmp-${process.pid}`;
await writeFile(helperTemporaryPath, renderCredentialHelper(config.deepseek.keychain), { mode: 0o700 });
await rename(helperTemporaryPath, helperPath);
await chmod(helperPath, 0o700);

if (openaiRequired) {
  await mkdir(dirname(openaiHelperPath), { recursive: true });
  const openaiHelperTemporaryPath = `${openaiHelperPath}.tmp-${process.pid}`;
  await writeFile(openaiHelperTemporaryPath, renderCredentialHelper(config.openai.keychain), { mode: 0o700 });
  await rename(openaiHelperTemporaryPath, openaiHelperPath);
  await chmod(openaiHelperPath, 0o700);
}

await mkdir(dirname(preferHelperPath), { recursive: true });
const preferTemporaryPath = `${preferHelperPath}.tmp-${process.pid}`;
await writeFile(preferTemporaryPath, renderPreferClaudeHybrid(), { mode: 0o700 });
await rename(preferTemporaryPath, preferHelperPath);
await chmod(preferHelperPath, 0o700);

await mkdir(launchAgentsDir, { recursive: true });
const plistTemporaryPath = `${plistPath}.tmp-${process.pid}`;
await writeFile(plistTemporaryPath, renderLaunchAgentPlist(process.execPath, routerPath, runtimeConfigPath, logDirectory), { mode: 0o644 });
await rename(plistTemporaryPath, plistPath);

run("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
const bootstrap = run("launchctl", ["bootstrap", domain, plistPath]);
if (bootstrap.status !== 0) {
  const message = `${bootstrap.stderr ?? ""}${bootstrap.stdout ?? ""}`;
  if (!/already bootstrapped|already loaded|service already loaded/i.test(message)) {
    throw new Error(`launchctl bootstrap failed: ${message}`);
  }
}
run("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
await waitForHealth(config.router.port);
await waitForUnix(routerSocketPath);

console.log("Claude Hybrid router is healthy; building the app copy.");
const patchResult = await patchClaudeApp({
  sourceApp,
  targetApp,
  routerBaseUrl,
  routerSocketPath,
  patchFile: config.app.patchFile,
  patchFrom: config.app.patchFrom,
  modelLabelPatchFile: config.app.modelLabelPatchFile,
  modelLabelPatchFrom: config.app.modelLabelPatchFrom,
  userDataDir: expand(config.app.userDataDir),
  patchVersion: config.app.patchVersion,
});

const header = await readAsarHeader(join(targetApp, "Contents/Resources/app.asar"));
if (header.headerSha256 !== patchResult.headerSha256) {
  throw new Error("Patched app asar header hash verification failed");
}

const launchServices = preferClaudeHybrid({ officialApp: sourceApp, hybridApp: targetApp });

console.log(JSON.stringify({
  layout,
  targetApp,
  managedDir,
  runtimeConfigPath,
  helperPath,
  openaiHelperPath,
  preferHelperPath,
  plistPath,
  routerPort: config.router.port,
  routerBaseUrl,
  routerSocketPath,
  patch: patchResult,
  launchServices,
  keychain: {
    deepseek: config.deepseek.keychain,
    ...(config.openai?.keychain ? { openai: config.openai.keychain } : {}),
  },
  note: "Open Claude from /Applications. It is the daily Hybrid app; keep Claude Official.app only as the pristine update source.",
}, null, 2));
