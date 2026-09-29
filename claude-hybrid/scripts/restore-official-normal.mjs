import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasHybridMarker,
  inspectAppleSignature,
  migrateLegacyOfficialSource,
  officialAppPath,
  pathExists,
  preferClaudeHybrid,
  legacyOfficialAppPath,
} from "../src/app-layout.mjs";
import { releaseDeepSeekOnlyOfficialAccount } from "../src/official-account.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

/**
 * Make Cloud.app behave like stock Official Claude:
 * - no Hybrid ASAR / router patches on the Official binary
 * - leave Claude-3p DeepSeek gateway (deploymentMode 3p) so packaged Claude
 *   stops showing only DeepSeek under an unfamiliar account
 *
 * Does not rebuild Hybrid and does not kill Claude. User must fully quit
 * Cloud.app / Claude and reopen Cloud.app after this runs.
 */
const cloudApp = process.env.CLAUDE_HYBRID_SOURCE ?? officialAppPath(home);
const hybridApp = process.env.CLAUDE_HYBRID_TARGET ?? "/Applications/Claude.app";
const legacyOfficial = legacyOfficialAppPath(home);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function plistValue(appPath, key) {
  const result = run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", join(appPath, "Contents/Info.plist"),
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const renamed = await migrateLegacyOfficialSource({ sourceApp: cloudApp, home });
const exists = await pathExists(cloudApp);
if (!exists) {
  console.log(JSON.stringify({
    status: "error",
    summary: "Cloud.app (pristine Official) is missing.",
    root_cause_hint: `Expected Apple-signed Official at ${cloudApp}`,
    next_actions: [
      "Install the latest Official Claude zip into ~/Applications/Cloud.app (do not ASAR-patch it).",
      "Then rerun restore-official-normal / this script.",
    ],
    artifacts: { cloudApp, legacyOfficial, renamed },
  }, null, 2));
  process.exitCode = 1;
  process.exit();
}

const hybridMarked = hasHybridMarker(cloudApp);
const signature = inspectAppleSignature(cloudApp);
const version = plistValue(cloudApp, "CFBundleShortVersionString");
const displayName = plistValue(cloudApp, "CFBundleDisplayName")
  ?? plistValue(cloudApp, "CFBundleName");

if (hybridMarked || !signature.ok) {
  console.log(JSON.stringify({
    status: "error",
    summary: "Cloud.app is not a pristine Apple-signed Official build.",
    root_cause_hint: hybridMarked
      ? "Cloud.app carries a Hybrid patch marker; replace it with an unpatched Official zip."
      : "Cloud.app failed Apple signature verification.",
    next_actions: [
      "Download the current Official Claude.zip from RELEASES.json.",
      "Backup and replace ~/Applications/Cloud.app with the staged Claude.app (ditto). Do not ASAR-patch it.",
      "Rerun this restore script, fully quit Claude/Cloud.app, then open Cloud.app.",
    ],
    artifacts: { cloudApp, version, displayName, hybridMarked, signature },
  }, null, 2));
  process.exitCode = 1;
  process.exit();
}

const officialAccount = await releaseDeepSeekOnlyOfficialAccount(home, { forceFirstParty: true });
const launchServices = preferClaudeHybrid({
  officialApp: cloudApp,
  hybridApp,
  legacyOfficialApp: legacyOfficial,
});

console.log(JSON.stringify({
  status: "success",
  summary: officialAccount.changed
    ? "Cloud.app is pristine Official; Claude-3p was switched to first-party (1p) so DeepSeek-only mode is off."
    : "Cloud.app is pristine Official; Claude-3p was already first-party or absent.",
  next_actions: [
    "Fully quit Cloud.app and Claude (pgrep -x Claude must be empty), then open ~/Applications/Cloud.app.",
    "Confirm the normal Anthropic account and native model list (not DeepSeek-only).",
    "Keep using /Applications/Claude.app for Hybrid (router / DeepSeek borrowed slots).",
  ],
  artifacts: {
    cloudApp,
    version,
    displayName,
    hybridMarked: false,
    signature,
    renamed,
    officialAccount,
    launchServices,
    projectRoot,
  },
}, null, 2));
