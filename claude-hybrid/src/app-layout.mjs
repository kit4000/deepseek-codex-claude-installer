import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const PREFER_HELPER_MARKER = "# Managed by deepseek-codex-claude-installer.";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function plistValue(appPath, key) {
  const result = run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", join(appPath, "Contents/Info.plist"),
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function hasHybridMarker(appPath) {
  return Boolean(plistValue(appPath, "ClaudeHybridPatchVersion"));
}

export function inspectAppleSignature(appPath) {
  const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const detail = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const output = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`;
  const authority = output.match(/^Authority=(.+)$/m)?.[1];
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const adHoc = /^Signature=adhoc$/m.test(output) || teamIdentifier === "not set";
  return {
    ok: verify.status === 0
      && detail.status === 0
      && Boolean(authority)
      && !adHoc
      && plistValue(appPath, "CFBundleIdentifier") === "com.anthropic.claudefordesktop",
    authority,
    teamIdentifier,
  };
}

export function isDefaultClaudeLayout({ sourceApp, targetApp, home }) {
  return resolve(sourceApp) === resolve(home, "Applications/Claude Official.app")
    && resolve(targetApp) === "/Applications/Claude.app";
}

export function decideClaudeAppLayout(state) {
  const actions = [];
  const warnings = [];

  if (!state.defaultLayout) {
    if (!state.sourceExists) {
      throw new Error("The configured Apple-signed pristine Claude source does not exist");
    }
    if (!state.sourceAppleSigned) {
      throw new Error("The configured Claude source is not pristine and Apple-signed");
    }
    return { actions: ["rebuild-hybrid"], warnings };
  }

  let sourceWillBeReplaced = false;
  if (state.targetExists && !state.targetIsHybrid) {
    if (!state.targetAppleSigned) {
      throw new Error("The unmarked /Applications/Claude.app is not an Apple-signed pristine Claude source");
    }
    if (state.sourceExists) actions.push("backup-official");
    actions.push("move-target-to-official");
    sourceWillBeReplaced = true;
  } else if (!state.sourceExists) {
    throw new Error("No Apple-signed pristine Claude source is available at ~/Applications/Claude Official.app");
  }
  if (!sourceWillBeReplaced && !state.sourceAppleSigned) {
    throw new Error("Claude Official source is not pristine and Apple-signed");
  }

  if (state.legacyExists) {
    if (state.legacyIsHybrid) actions.push("backup-legacy-hybrid");
    else warnings.push("legacy-target-unmarked");
  }
  actions.push("rebuild-hybrid");
  return { actions, warnings };
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function safeVersion(appPath) {
  return (plistValue(appPath, "CFBundleShortVersionString") ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function prepareClaudeAppLayout({ sourceApp, targetApp, home }) {
  if (resolve(sourceApp) === resolve(targetApp)) {
    throw new Error("Claude Hybrid target must not point to the pristine source app");
  }
  const legacyTarget = resolve(home, "Applications/Claude Hybrid.app");
  const defaultLayout = isDefaultClaudeLayout({ sourceApp, targetApp, home });
  const sourceExists = await pathExists(sourceApp);
  const sourceAppleSigned = sourceExists
    && !hasHybridMarker(sourceApp)
    && inspectAppleSignature(sourceApp).ok;
  const targetExists = await pathExists(targetApp);
  const legacyExists = defaultLayout && await pathExists(legacyTarget);
  const targetIsHybrid = targetExists && hasHybridMarker(targetApp);
  const targetAppleSigned = targetExists && !targetIsHybrid && inspectAppleSignature(targetApp).ok;
  const legacyIsHybrid = legacyExists && hasHybridMarker(legacyTarget);
  const plan = decideClaudeAppLayout({
    defaultLayout,
    sourceExists,
    sourceAppleSigned,
    targetExists,
    targetIsHybrid,
    targetAppleSigned,
    legacyExists,
    legacyIsHybrid,
  });
  const moved = [];
  const suffix = timestamp();

  for (const action of plan.actions) {
    if (action === "backup-official") {
      const backup = `${sourceApp}.before-${safeVersion(sourceApp)}-${suffix}`;
      await rename(sourceApp, backup);
      moved.push({ from: sourceApp, to: backup, role: "official-backup" });
    } else if (action === "move-target-to-official") {
      await mkdir(dirname(sourceApp), { recursive: true });
      await rename(targetApp, sourceApp);
      moved.push({ from: targetApp, to: sourceApp, role: "official-source" });
    } else if (action === "backup-legacy-hybrid") {
      const backup = `${legacyTarget}.before-migration-${suffix}`;
      await rename(legacyTarget, backup);
      moved.push({ from: legacyTarget, to: backup, role: "legacy-hybrid-backup" });
    }
  }

  const sourceSignature = inspectAppleSignature(sourceApp);
  if (!sourceSignature.ok || hasHybridMarker(sourceApp)) {
    throw new Error(`Claude Official source is not pristine and Apple-signed: ${sourceApp}`);
  }
  return { sourceApp, targetApp, legacyTarget, plan, moved, sourceSignature };
}

export function renderPreferClaudeHybrid() {
  return [
    "#!/bin/sh",
    "set -e",
    PREFER_HELPER_MARKER,
    `LSREGISTER=${JSON.stringify(LSREGISTER)}`,
    'OFFICIAL="${HOME}/Applications/Claude Official.app"',
    'HYBRID="/Applications/Claude.app"',
    '"$LSREGISTER" -u "$OFFICIAL" >/dev/null 2>&1 || true',
    '"$LSREGISTER" -f -R "$HYBRID"',
    'echo "Launch Services now prefers: $HYBRID"',
    "",
  ].join("\n");
}

export function preferClaudeHybrid({
  officialApp,
  hybridApp,
  runner = run,
}) {
  const unregistered = runner(LSREGISTER, ["-u", officialApp]);
  const registered = runner(LSREGISTER, ["-f", "-R", hybridApp]);
  if (registered.error) throw registered.error;
  if (registered.status !== 0) {
    throw new Error(`Launch Services registration failed: ${registered.stderr?.trim() || registered.stdout?.trim()}`);
  }
  return {
    officialApp,
    hybridApp,
    officialUnregisterStatus: unregistered.status,
    hybridRegisterStatus: registered.status,
  };
}

export async function readManagedHelper(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
