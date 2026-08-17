import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAsarFile } from "../src/asar-repack.mjs";
import { migrateClaudeHybridPatchVersion } from "../src/app-patch.mjs";
import { decideClaudeHybridUpdate } from "../src/update-plan.mjs";
import { hasHybridMarker, inspectAppleSignature, preferClaudeHybrid } from "../src/app-layout.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
if (apply && args.has("--check")) throw new Error("Choose either --check or --apply");
const mode = apply ? "apply" : "check";
const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);
const sourceApp = process.env.CLAUDE_HYBRID_SOURCE ?? expand(config.app.source);
const targetApp = process.env.CLAUDE_HYBRID_TARGET ?? expand(config.app.target);

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { encoding: "utf8", ...options });
}

function inspectInstalledCompatibility() {
  const result = run(process.execPath, [resolve(projectRoot, "scripts/verify.mjs")], {
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return false;
  if (result.status !== 0) return false;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  const required = [
    "asarIntegrity",
    "appPatch",
    "modelLabelPatch",
    "codesign",
    "router",
    "routerSocket",
    "modelList",
    "launchAgent",
    "userDataDir",
    "sourceAppleSignature",
    "displayName",
    "autoUpdaterDisabled",
    "hybridMarker",
  ];
  return required.every((name) => report.checks?.[name]?.ok === true);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function plistValue(appPath, key) {
  const result = run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", join(appPath, "Contents/Info.plist"),
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function inspectState() {
  const sourceExists = await exists(sourceApp);
  const targetExists = await exists(targetApp);
  const signature = sourceExists ? inspectAppleSignature(sourceApp) : { ok: false };
  let environmentAnchorPresent = false;
  let labelAnchorPresent = false;
  if (sourceExists) {
    try {
      const asarPath = join(sourceApp, "Contents/Resources/app.asar");
      const environmentSource = await readAsarFile(asarPath, config.app.patchFile);
      const labelSource = await readAsarFile(asarPath, config.app.modelLabelPatchFile);
      environmentAnchorPresent = Boolean(environmentSource?.includes(config.app.patchFrom));
      labelAnchorPresent = Boolean(labelSource?.includes(config.app.modelLabelPatchFrom));
    } catch {}
  }
  const credential = run("/usr/bin/security", [
    "find-generic-password",
    "-s", config.deepseek.keychain.service,
    "-a", config.deepseek.keychain.account,
    "-w",
  ], { stdio: "ignore", timeout: 5000 });
  const openaiCredential = run("/usr/bin/security", [
    "find-generic-password",
    "-s", config.openai.keychain.service,
    "-a", config.openai.keychain.account,
    "-w",
  ], { stdio: "ignore", timeout: 5000 });
  const running = run("/usr/bin/pgrep", ["-x", "Claude"]);
  return {
    sourceApp,
    targetApp,
    sourceVersion: sourceExists ? plistValue(sourceApp, "CFBundleShortVersionString") : undefined,
    sourceBuild: sourceExists ? plistValue(sourceApp, "CFBundleVersion") : undefined,
    targetExists,
    targetVersion: targetExists ? plistValue(targetApp, "CFBundleShortVersionString") : undefined,
    targetBuild: targetExists ? plistValue(targetApp, "CFBundleVersion") : undefined,
    installedPatchVersion: targetExists ? plistValue(targetApp, "ClaudeHybridPatchVersion") : undefined,
    expectedPatchVersion: config.app.patchVersion,
    sourceSignatureValid: sourceExists && signature.ok && !hasHybridMarker(sourceApp),
    environmentAnchorPresent,
    labelAnchorPresent,
    credentialAvailable: credential.status === 0,
    openaiCredentialAvailable: openaiCredential.status === 0,
    openaiRequired: (config.models?.external ?? []).some((entry) => entry.provider === "openai"),
    claudeRunning: running.status === 0,
    targetPatchCompatible: targetExists ? inspectInstalledCompatibility() : false,
  };
}

function runManagedScript(name) {
  const result = run(process.execPath, [resolve(projectRoot, "scripts", name)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status}`);
}

try {
  const state = await inspectState();
  const plan = decideClaudeHybridUpdate(state, mode);
  if (mode === "check") {
    console.log(JSON.stringify(plan, null, 2));
    if (plan.status === "error") process.exitCode = 1;
  } else if (plan.status === "error" || (plan.status === "warning" && state.claudeRunning)) {
    console.log(JSON.stringify(plan, null, 2));
    process.exitCode = 1;
  } else {
    let migration;
    if (plan.status !== "success" && plan.artifacts.updateKind === "metadata-migration") {
      migration = await migrateClaudeHybridPatchVersion({
        targetApp,
        patchVersion: config.app.patchVersion,
      });
    } else if (plan.status !== "success") {
      runManagedScript("install.mjs");
    }
    runManagedScript("verify.mjs");
    const launchServices = preferClaudeHybrid({ officialApp: sourceApp, hybridApp: targetApp });
    console.log(JSON.stringify({
      status: "success",
      summary: plan.status === "success"
        ? "Claude Hybrid was already current and passed verification."
        : migration
          ? "Claude Hybrid metadata was migrated without rewriting its verified app patch."
          : "Claude Hybrid was rebuilt from the signed official app and passed verification.",
      next_actions: [
        "Open Claude from /Applications and approve the Claude Safe Storage prompt if macOS shows it.",
        "Confirm Fable 5, Opus 4.8, Opus 5, Sonnet 5, and Haiku 4.5 remain native.",
        "Confirm Opus 4.6 / Sonnet 4.6 show DeepSeek.",
        "Start a Code session and confirm it appears in claude.ai/code or the mobile app.",
      ],
      artifacts: { sourceApp, targetApp, expectedPatchVersion: config.app.patchVersion, migration, launchServices },
    }, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({
    status: "error",
    summary: "Claude Hybrid update failed.",
    root_cause_hint: error.message,
    next_actions: [
      "Do not patch Claude Official.app or delete sessions.",
      "Resolve the reported preflight or verification failure, then rerun --check before --apply.",
    ],
    artifacts: { sourceApp, targetApp, configPath },
  }, null, 2));
  process.exitCode = 1;
}
