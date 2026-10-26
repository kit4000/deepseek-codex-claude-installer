#!/usr/bin/env node

/**
 * Claude が起動中でも安全に、終了後へ純正 Claude.app 復元を予約する。
 * Do not kill Claude. Official source is never ASAR-patched.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LSREGISTER, hasHybridMarker, inspectAppleSignature, pathExists } from "../src/app-layout.mjs";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun && process.platform !== "darwin") {
  throw new Error("This restore helper supports macOS only");
}

const officialApp = process.env.CLAUDE_HYBRID_SOURCE ?? join(home, "Applications/Claude Official.app");
const dailyApp = process.env.CLAUDE_HYBRID_TARGET ?? "/Applications/Claude.app";
const managedDir = process.env.CLAUDE_HYBRID_RUNTIME_DIR
  ?? join(home, "Library/Application Support/Claude Hybrid");
const logDirectory = join(home, "Library/Logs/Claude Hybrid");
const scriptPath = join(managedDir, "restore-official-claude.sh");
const label = "com.local.restore-official-claude";
const plistPath = join(home, "Library/LaunchAgents", `${label}.plist`);
const logPath = join(logDirectory, "restore-official.log");
const okPath = join(logDirectory, "restore-official.ok");
const domain = `gui/${process.getuid()}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function claudeIsRunning() {
  return run("/usr/bin/pgrep", ["-x", "Claude"], { stdio: "ignore" }).status === 0;
}

export function renderRestoreOfficialScript({
  officialApp: official,
  dailyApp: daily,
  lsregister = LSREGISTER,
  hybridRouterLabel = "com.local.claude-hybrid-router",
  logPath: outLog,
  okPath: successPath,
  selfLabel = label,
}) {
  return `#!/bin/bash
# Managed by deepseek-codex-claude-installer. restore-official-on-quit
set -euo pipefail

OFFICIAL=${shellQuote(official)}
DAILY=${shellQuote(daily)}
LSREGISTER=${shellQuote(lsregister)}
LOG=${shellQuote(outLog)}
OK=${shellQuote(successPath)}
SELF_LABEL=${shellQuote(selfLabel)}
HYBRID_ROUTER_LABEL=${shellQuote(hybridRouterLabel)}
UID_NUM="$(id -u)"
DOMAIN="gui/\${UID_NUM}"
MAX_WAIT_SECONDS=7200
WAITED=0

mkdir -p "$(dirname "$LOG")" "$(dirname "$OK")"
exec >>"$LOG" 2>&1
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore-official-claude waiting for Claude to quit"

while /usr/bin/pgrep -x Claude >/dev/null 2>&1; do
  if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] timed out waiting for Claude; leaving Hybrid in place"
    launchctl bootout "$DOMAIN/$SELF_LABEL" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Claude is not running; restoring pristine daily app"

if [ ! -d "$OFFICIAL" ]; then
  echo "Official source missing: $OFFICIAL" >&2
  exit 1
fi

if /usr/bin/plutil -extract ClaudeHybridPatchVersion raw -o - "$OFFICIAL/Contents/Info.plist" >/dev/null 2>&1; then
  echo "Refusing to restore from a Hybrid-marked Official source" >&2
  exit 1
fi

if ! /usr/bin/codesign --verify --deep --strict "$OFFICIAL"; then
  echo "Official source failed codesign verification" >&2
  exit 1
fi

BUNDLE_ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$OFFICIAL/Contents/Info.plist" 2>/dev/null || true)"
if [ "$BUNDLE_ID" != "com.anthropic.claudefordesktop" ]; then
  echo "Unexpected Official CFBundleIdentifier: $BUNDLE_ID" >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
if [ -d "$DAILY" ]; then
  if /usr/bin/plutil -extract ClaudeHybridPatchVersion raw -o - "$DAILY/Contents/Info.plist" >/dev/null 2>&1; then
    BACKUP="/Applications/Claude.app.before-deepseek-restore-\${STAMP}"
    echo "Moving Hybrid daily app to $BACKUP"
    /bin/mv "$DAILY" "$BACKUP"
    "$LSREGISTER" -u "$BACKUP" >/dev/null 2>&1 || true
  elif /usr/bin/codesign --verify --deep --strict "$DAILY" >/dev/null 2>&1 \\
    && ! /usr/bin/plutil -extract ClaudeHybridPatchVersion raw -o - "$DAILY/Contents/Info.plist" >/dev/null 2>&1; then
    echo "Daily app is already pristine Official; skipping replace"
  else
    BACKUP="/Applications/Claude.app.before-deepseek-restore-\${STAMP}"
    echo "Moving unmarked daily app aside to $BACKUP"
    /bin/mv "$DAILY" "$BACKUP"
    "$LSREGISTER" -u "$BACKUP" >/dev/null 2>&1 || true
  fi
fi

if [ ! -d "$DAILY" ]; then
  echo "Copying Official to $DAILY"
  if ! /bin/cp -cR "$OFFICIAL" "$DAILY" 2>/dev/null; then
    /usr/bin/ditto "$OFFICIAL" "$DAILY"
  fi
fi

if /usr/bin/plutil -extract ClaudeHybridPatchVersion raw -o - "$DAILY/Contents/Info.plist" >/dev/null 2>&1; then
  echo "Restored daily app unexpectedly has Hybrid marker" >&2
  exit 1
fi
if ! /usr/bin/codesign --verify --deep --strict "$DAILY"; then
  echo "Restored daily app failed codesign verification" >&2
  exit 1
fi

"$LSREGISTER" -f -R "$DAILY" >/dev/null 2>&1 || "$LSREGISTER" -f "$DAILY" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$OFFICIAL" >/dev/null 2>&1 || true

launchctl bootout "$DOMAIN/$HYBRID_ROUTER_LABEL" >/dev/null 2>&1 || true

{
  echo "restoredAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "dailyApp=$DAILY"
  echo "officialApp=$OFFICIAL"
  echo "dailyHybridMarker=absent"
  echo "dailyCodesign=ok"
} >"$OK"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore complete"
launchctl bootout "$DOMAIN/$SELF_LABEL" >/dev/null 2>&1 || true
`;
}

export function renderRestoreOfficialPlist({ scriptPath: program, logPath: stdio }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(program)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdio)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stdio)}</string>
</dict>
</plist>
`;
}

async function main() {
  const officialExists = await pathExists(officialApp);
  if (!officialExists) {
    throw new Error(`Official Claude is missing: ${officialApp}`);
  }
  if (hasHybridMarker(officialApp)) {
    throw new Error(`Official source has a Hybrid marker; refusing to schedule restore from ${officialApp}`);
  }
  const signature = inspectAppleSignature(officialApp);
  if (!signature.ok) {
    throw new Error(`Official Claude is not Apple-signed: ${officialApp}`);
  }

  await mkdir(managedDir, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });

  const script = renderRestoreOfficialScript({
    officialApp,
    dailyApp,
    logPath,
    okPath,
  });
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);

  const plist = renderRestoreOfficialPlist({ scriptPath, logPath });
  const temporaryPlist = `${plistPath}.tmp-${process.pid}`;
  await writeFile(temporaryPlist, plist, { mode: 0o644 });
  run("/bin/mv", ["-f", temporaryPlist, plistPath]);

  run("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  const bootstrap = run("launchctl", ["bootstrap", domain, plistPath]);
  if (bootstrap.status !== 0) {
    const message = `${bootstrap.stderr ?? ""}${bootstrap.stdout ?? ""}`;
    if (!/already bootstrapped|already loaded|service already loaded/i.test(message)) {
      throw new Error(`launchctl bootstrap failed: ${message}`);
    }
  }
  run("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });

  const print = run("launchctl", ["print", `${domain}/${label}`]);
  const loaded = print.status === 0;

  console.log(JSON.stringify({
    ok: true,
    deferred: true,
    claudeRunning: claudeIsRunning(),
    officialApp,
    dailyApp,
    scriptPath,
    plistPath,
    logPath,
    okPath,
    launchAgentLoaded: loaded,
    next: [
      "Quit Claude completely when ready (Do not force-kill from this helper).",
      "On quit, LaunchAgent restores Apple-signed Official to /Applications/Claude.app.",
      "Hybrid daily app is renamed to Claude.app.before-deepseek-restore-<timestamp>.",
      "Hybrid router LaunchAgent is booted out; Official source is left untouched.",
      `Confirm with: plutil -extract ClaudeHybridPatchVersion raw -o - ${dailyApp}/Contents/Info.plist  (should fail)`,
      `Confirm with: codesign --verify --deep --strict ${dailyApp}`,
    ],
  }, null, 2));
}

if (isDirectRun) {
  await main();
}
