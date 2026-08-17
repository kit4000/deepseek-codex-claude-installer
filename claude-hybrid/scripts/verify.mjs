import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAsarFile, readAsarHeader } from "../src/asar-repack.mjs";
import { hasHybridMarker, inspectAppleSignature } from "../src/app-layout.mjs";
import { environmentPatchEntries } from "../src/app-patch.mjs";
import { requestUnix } from "../src/router.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);
const targetApp = process.env.CLAUDE_HYBRID_TARGET ?? expand(config.app.target);
const sourceApp = process.env.CLAUDE_HYBRID_SOURCE ?? expand(config.app.source);
const customLayout = Boolean(process.env.CLAUDE_HYBRID_SOURCE || process.env.CLAUDE_HYBRID_TARGET);
const routerBaseUrl = process.env.CLAUDE_HYBRID_ROUTER_URL ?? expand(config.app.routerBaseUrl);
const routerSocketPath = process.env.CLAUDE_HYBRID_ROUTER_SOCKET ?? expand(config.router.socketPath);
const userDataDir = process.env.CLAUDE_HYBRID_USER_DATA_DIR ?? expand(config.app.userDataDir);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

const report = { ok: true, checks: {} };

try {
  const sourceSignature = inspectAppleSignature(sourceApp);
  report.checks.sourceAppleSignature = {
    ok: sourceSignature.ok && !hasHybridMarker(sourceApp),
    authority: sourceSignature.authority,
    teamIdentifier: sourceSignature.teamIdentifier,
  };
  report.checks.layoutPaths = {
    ok: customLayout || (sourceApp === `${home}/Applications/Claude Official.app` && targetApp === "/Applications/Claude.app"),
    sourceApp,
    targetApp,
  };
  const asarPath = join(targetApp, "Contents/Resources/app.asar");
  const header = await readAsarHeader(asarPath);
  const plistScript = `
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
print(data["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"])
`;
  const plistHash = run("/usr/bin/python3", ["-c", plistScript, join(targetApp, "Contents/Info.plist")]);
  report.checks.asarIntegrity = {
    ok: plistHash.status === 0 && plistHash.stdout.trim() === header.headerSha256,
    headerSha256: header.headerSha256,
  };

  const patchedFile = await readAsarFile(asarPath, config.app.patchFile);
  const requiredEnvironmentPatches = environmentPatchEntries({
    routerBaseUrl,
    routerSocketPath,
  });
  report.checks.appPatch = {
    ok: Boolean(
      patchedFile
      && requiredEnvironmentPatches.every((value) => patchedFile.includes(value))
      && !patchedFile.includes("ANTHROPIC_CUSTOM_MODEL_OPTION")
    ),
  };

  const uiPatch = await readAsarFile(asarPath, config.app.modelLabelPatchFile);
  report.checks.modelLabelPatch = {
    ok: Boolean(
      uiPatch?.includes("__CLAUDE_HYBRID_MODEL_LABELS__")
      && uiPatch?.includes("Sonnet 4.6")
      && uiPatch?.includes("Opus 4.6")
      && uiPatch?.includes("DeepSeek V4 Flash")
      && uiPatch?.includes("DeepSeek V4 Pro (1M)")
      && !uiPatch?.includes("GPT-5.6 Luna")
      && !uiPatch?.includes("GPT-5.6 Sol"),
    ),
  };

  const codesign = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetApp]);
  report.checks.codesign = { ok: codesign.status === 0 };

  const displayName = run("/usr/bin/plutil", [
    "-extract", "CFBundleDisplayName", "raw", "-o", "-", join(targetApp, "Contents/Info.plist"),
  ]);
  report.checks.displayName = { ok: displayName.status === 0 && displayName.stdout.trim() === "Claude", value: displayName.stdout.trim() };

  const updater = run("/usr/bin/plutil", [
    "-extract", "LSEnvironment.DISABLE_AUTOUPDATER", "raw", "-o", "-", join(targetApp, "Contents/Info.plist"),
  ]);
  report.checks.autoUpdaterDisabled = { ok: updater.status === 0 && updater.stdout.trim() === "1", value: updater.stdout.trim() };

  report.checks.hybridMarker = { ok: hasHybridMarker(targetApp) };

  const healthResponse = await fetch(`http://127.0.0.1:${config.router.port}/healthz`, {
    signal: AbortSignal.timeout(1000),
  });
  const health = healthResponse.ok ? await healthResponse.json() : undefined;
  report.checks.router = {
    ok: healthResponse.ok && health?.provider === "claude-hybrid",
    status: healthResponse.status,
    body: health,
  };

  let unixHealth;
  try {
    const unixResult = await requestUnix(routerSocketPath, { path: "/healthz", timeoutMs: 1000 });
    unixHealth = unixResult.statusCode === 200 ? JSON.parse(unixResult.body.toString("utf8")) : undefined;
    report.checks.routerSocket = {
      ok: unixResult.statusCode === 200 && unixHealth?.ok === true && unixHealth?.socketPath === routerSocketPath,
      status: unixResult.statusCode,
      socketPath: routerSocketPath,
    };
  } catch (error) {
    report.checks.routerSocket = {
      ok: false,
      socketPath: routerSocketPath,
      error: { name: error?.name, message: error?.message },
    };
  }

  const modelsResponse = await fetch(`http://127.0.0.1:${config.router.port}/v1/models`, {
    signal: AbortSignal.timeout(3000),
  });
  const models = modelsResponse.ok ? await modelsResponse.json() : { data: [] };
  const externalIds = config.models.external.map((entry) => entry.id);
  report.checks.modelList = {
    ok: externalIds.every((id) => models.data?.some((entry) => entry.id === id)),
    ids: models.data?.map((entry) => entry.id) ?? [],
  };

  const launchctl = run("launchctl", ["print", `gui/${process.getuid()}/${config.launchAgent.label}`]);
  report.checks.launchAgent = {
    ok: launchctl.status === 0 && /state = running/i.test(launchctl.stdout ?? ""),
  };

  const envPlistScript = `
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
print(data["LSEnvironment"].get("CLAUDE_USER_DATA_DIR", ""))
`;
  const envPlist = run("/usr/bin/python3", ["-c", envPlistScript, join(targetApp, "Contents/Info.plist")]);
  report.checks.userDataDir = {
    ok: envPlist.status === 0 && envPlist.stdout.trim() === userDataDir,
    value: envPlist.stdout.trim(),
  };

  const patchVersion = run("/usr/bin/plutil", [
    "-extract", "ClaudeHybridPatchVersion", "raw", "-o", "-", join(targetApp, "Contents/Info.plist"),
  ]);
  report.checks.patchVersion = {
    ok: patchVersion.status === 0 && patchVersion.stdout.trim() === config.app.patchVersion,
    expected: config.app.patchVersion,
    value: patchVersion.stdout.trim(),
  };
} catch (error) {
  report.ok = false;
  report.error = { name: error?.name, message: error?.message };
}

report.ok = Object.values(report.checks).every((check) => check.ok !== false);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
