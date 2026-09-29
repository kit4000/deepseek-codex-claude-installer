import { spawnSync } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import {
  quarantineClaude3pSupport,
  releaseDeepSeekOnlyOfficialAccount,
} from "../src/official-account.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

/**
 * Hard reset Cloud.app to stock Official Claude with no DeepSeek 3p gateway:
 * 1. Force Claude-3p deploymentMode to 1p (if the folder still exists)
 * 2. Quarantine the entire Claude-3p support directory (rename aside)
 * 3. Replace Cloud.app with a fresh Apple-signed Official build when missing,
 *    hybrid-marked, or unsigned
 * 4. Re-prefer Hybrid for Launch Services so daily Claude stays Hybrid
 *
 * Does not kill Claude. User must fully quit Claude/Cloud.app, then:
 *   open -n "$HOME/Applications/Cloud.app"
 */
const cloudApp = process.env.CLAUDE_HYBRID_SOURCE ?? officialAppPath(home);
const hybridApp = process.env.CLAUDE_HYBRID_TARGET ?? "/Applications/Claude.app";
const legacyOfficial = legacyOfficialAppPath(home);
const refreshApp = process.argv.includes("--refresh-app") || process.env.RESTORE_OFFICIAL_REFRESH_APP === "1";
const officialVersion = process.env.CLAUDE_OFFICIAL_VERSION ?? "2.9939.4";
const officialZipUrl = process.env.CLAUDE_OFFICIAL_ZIP_URL
  ?? `https://downloads.claude.ai/releases/darwin/universal/${officialVersion}/Claude-a166d8a7c640e65ad825ebfb99d74ccbb9c8940d.zip`;
const officialZipSha256 = process.env.CLAUDE_OFFICIAL_ZIP_SHA256
  ?? "93cc637cc2b38bb78c57ae072dd817b9b17fa8cb01aaedfe2454e6c60498c28f";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function requireOk(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function plistValue(appPath, key) {
  const result = run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", join(appPath, "Contents/Info.plist"),
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function sha256File(path) {
  const hashed = requireOk(run("/usr/bin/shasum", ["-a", "256", path]), "shasum");
  return hashed.stdout.trim().split(/\s+/)[0];
}

async function installFreshOfficial(targetApp) {
  const stage = join("/tmp", `claude-${officialVersion}-restore-${process.pid}`);
  const zipPath = join(stage, "Claude.zip");
  requireOk(run("/bin/rm", ["-rf", stage]), "rm stage");
  requireOk(run("/bin/mkdir", ["-p", stage]), "mkdir stage");
  requireOk(run("/usr/bin/curl", ["-fsSL", officialZipUrl, "-o", zipPath]), "download Official zip");
  const actual = await sha256File(zipPath);
  if (actual !== officialZipSha256) {
    throw new Error(`Official zip SHA-256 mismatch: ${actual} != ${officialZipSha256}`);
  }
  requireOk(run("/usr/bin/ditto", ["-xk", zipPath, stage]), "extract Official zip");
  const stagedApp = join(stage, "Claude.app");
  requireOk(run("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]), "codesign staged Official");
  await mkdir(dirname(targetApp), { recursive: true });
  if (await pathExists(targetApp)) {
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
    await rename(targetApp, `${targetApp}.before-restore-${stamp}`);
  }
  requireOk(run("/usr/bin/ditto", [stagedApp, targetApp]), "ditto Official to Cloud.app");
  requireOk(run("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetApp]), "codesign Cloud.app");
  return {
    version: plistValue(targetApp, "CFBundleShortVersionString"),
    zipSha256: actual,
    stage,
  };
}

const renamed = await migrateLegacyOfficialSource({ sourceApp: cloudApp, home });

// Always strip the DeepSeek 3p trap before inspecting the app.
const officialAccount = await releaseDeepSeekOnlyOfficialAccount(home, { forceFirstParty: true });
const quarantined = await quarantineClaude3pSupport(home);

let refreshed = null;
let exists = await pathExists(cloudApp);
let hybridMarked = exists && hasHybridMarker(cloudApp);
let signature = exists ? inspectAppleSignature(cloudApp) : { ok: false };
const needsFreshApp = refreshApp || !exists || hybridMarked || !signature.ok;

if (needsFreshApp) {
  if (process.platform !== "darwin") {
    console.log(JSON.stringify({
      status: "error",
      summary: "Cloud.app restore requires macOS to download and install Official.",
      root_cause_hint: `platform=${process.platform}`,
      artifacts: { cloudApp, officialAccount, quarantined, renamed },
    }, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  refreshed = await installFreshOfficial(cloudApp);
  exists = true;
  hybridMarked = hasHybridMarker(cloudApp);
  signature = inspectAppleSignature(cloudApp);
}

if (!exists || hybridMarked || !signature.ok) {
  console.log(JSON.stringify({
    status: "error",
    summary: "Cloud.app is still not a pristine Apple-signed Official build.",
    root_cause_hint: !exists
      ? "Cloud.app missing after refresh attempt"
      : hybridMarked
        ? "Cloud.app still has a Hybrid patch marker"
        : "Cloud.app failed Apple signature verification",
    next_actions: [
      "Rerun with --refresh-app on the Mac that has Cloud.app.",
      "Fully quit Claude/Cloud.app, then: open -n \"$HOME/Applications/Cloud.app\"",
    ],
    artifacts: { cloudApp, hybridMarked, signature, refreshed, officialAccount, quarantined },
  }, null, 2));
  process.exitCode = 1;
  process.exit();
}

const version = plistValue(cloudApp, "CFBundleShortVersionString");
const displayName = plistValue(cloudApp, "CFBundleDisplayName")
  ?? plistValue(cloudApp, "CFBundleName");
const launchServices = preferClaudeHybrid({
  officialApp: cloudApp,
  hybridApp,
  legacyOfficialApp: legacyOfficial,
});

// Prove Claude-3p is gone from the live path.
const threePGone = !(await pathExists(resolve(home, "Library/Application Support/Claude-3p")));

console.log(JSON.stringify({
  status: threePGone && signature.ok && !hybridMarked ? "success" : "error",
  summary: threePGone
    ? "Claude-3p DeepSeek gateway quarantined; Cloud.app is pristine Official. Quit Claude fully, then open -n Cloud.app."
    : "Failed to quarantine Claude-3p; Cloud.app may still enter DeepSeek-only mode.",
  next_actions: [
    "Fully quit Cloud.app and Claude (Dock → Quit, confirm pgrep -x Claude is empty). Do not kill -9 unless asked.",
    "Open Official with: open -n \"$HOME/Applications/Cloud.app\"",
    "Confirm the normal Anthropic account and full native model list (not DeepSeek-only).",
    "Hybrid remains at /Applications/Claude.app for DeepSeek borrowed slots.",
  ],
  artifacts: {
    cloudApp,
    version,
    displayName,
    hybridMarked: false,
    signature,
    renamed,
    refreshed,
    officialAccount,
    quarantined,
    threePGone,
    launchServices,
    projectRoot,
  },
}, null, 2));

if (!threePGone) process.exitCode = 1;
