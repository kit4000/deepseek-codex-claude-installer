import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const ZIP_URL = /^https:\/\/downloads\.claude\.ai\/releases\/darwin\/universal\/(\d+\.\d+\.\d+)\/Claude-[0-9a-f]{40}\.zip$/;
const BUNDLE_ID = "com.anthropic.claudefordesktop";

export function pinnedOfficialRelease(app) {
  const version = app?.officialVersion;
  const url = app?.officialZipUrl;
  const sha256 = app?.officialZipSha256;
  if (typeof version !== "string" || typeof url !== "string" || typeof sha256 !== "string") {
    throw new Error("Pinned official Claude release is incomplete");
  }
  const match = ZIP_URL.exec(url);
  if (!match || match[1] !== version) {
    throw new Error("Pinned official Claude zip URL does not match officialVersion");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Pinned official Claude zip SHA-256 is invalid");
  }
  return { version, url, sha256 };
}

export function localStamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

export function officialBackupPath(applicationsDir, fromVersion, stamp) {
  const version = fromVersion ?? "unknown";
  if (!/^(\d+\.\d+\.\d+|unknown)$/.test(version)) {
    throw new Error("Official backup version is invalid");
  }
  if (!/^\d{8}-\d{6}$/.test(stamp ?? "")) {
    throw new Error("Official backup timestamp is invalid");
  }
  return join(applicationsDir, `Claude Official.app.before-${version}-${stamp}`);
}

export async function digestFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

function defaultRun(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: "utf8" });
}

async function defaultExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultDownload(url, destination) {
  const result = defaultRun("/usr/bin/curl", ["-fL", "--retry", "3", "-o", destination, url]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Official zip download failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function commandFailed(command, result) {
  const detail = (result.stderr || result.stdout || result.error?.message || "failed").trim();
  return new Error(`${command} failed: ${detail}`);
}

export async function installPinnedOfficialApp({
  release,
  sourceApp,
  stageRoot,
  stamp,
  fromVersion,
  sourceExists,
  downloadFile = defaultDownload,
  hashContents = digestFile,
  pathExists = defaultExists,
  renamePath = rename,
  runCommand = defaultRun,
  mkdirPath = mkdir,
}) {
  pinnedOfficialRelease({
    officialVersion: release?.version,
    officialZipUrl: release?.url,
    officialZipSha256: release?.sha256,
  });
  if (basename(sourceApp) !== "Claude Official.app") {
    throw new Error("Refusing to replace anything except Claude Official.app");
  }
  if (sourceApp === "/Applications/Claude.app") {
    throw new Error("Refusing to replace the daily Hybrid app");
  }
  await mkdirPath(stageRoot, { recursive: true });
  const zipPath = join(stageRoot, "Claude.zip");
  const stagedApp = join(stageRoot, "Claude.app");
  await downloadFile(release.url, zipPath);
  const actualHash = await hashContents(zipPath);
  if (actualHash !== release.sha256) {
    throw new Error("Official zip SHA-256 does not match the pinned release");
  }
  const extracted = runCommand("/usr/bin/ditto", ["-xk", zipPath, stageRoot]);
  if (extracted.status !== 0) throw commandFailed("/usr/bin/ditto", extracted);
  if (!await pathExists(stagedApp)) {
    throw new Error("Official zip did not contain Claude.app");
  }
  const signed = runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
  if (signed.status !== 0) throw commandFailed("/usr/bin/codesign", signed);
  const notarized = runCommand("/usr/bin/spctl", ["-a", "-vv", stagedApp]);
  if (notarized.status !== 0) throw commandFailed("/usr/bin/spctl", notarized);
  const plistPath = join(stagedApp, "Contents/Info.plist");
  const version = runCommand("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath]);
  if (version.status !== 0) throw commandFailed("/usr/bin/plutil", version);
  if (version.stdout.trim() !== release.version) {
    throw new Error(`Staged Claude version ${version.stdout.trim()} does not match ${release.version}`);
  }
  const bundleId = runCommand("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath]);
  if (bundleId.status !== 0) throw commandFailed("/usr/bin/plutil", bundleId);
  if (bundleId.stdout.trim() !== BUNDLE_ID) {
    throw new Error("Staged Claude bundle id is not the official desktop app");
  }
  let backupPath;
  if (sourceExists) {
    backupPath = officialBackupPath(dirname(sourceApp), fromVersion, stamp);
    if (await pathExists(backupPath)) {
      throw new Error(`Official backup already exists: ${backupPath}`);
    }
    await renamePath(sourceApp, backupPath);
  }
  const installed = runCommand("/usr/bin/ditto", [stagedApp, sourceApp]);
  if (installed.status !== 0) {
    if (backupPath) {
      await renamePath(backupPath, sourceApp);
    }
    throw commandFailed("/usr/bin/ditto", installed);
  }
  return {
    sourceApp,
    version: release.version,
    sha256: release.sha256,
    backupPath: backupPath ?? null,
  };
}
