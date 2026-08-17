import { constants } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repackAsar, readAsarHeader } from "./asar-repack.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
  return result;
}

export const MODEL_LABEL_REWRITES = [
  ["Sonnet 4.6", "DeepSeek V4 Flash"],
  ["Opus 4.6", "DeepSeek V4 Pro (1M)"],
];

export function environmentPatchEntries({ routerBaseUrl, routerSocketPath }) {
  if (typeof routerBaseUrl !== "string" || routerBaseUrl.length === 0) {
    throw new Error("routerBaseUrl is required");
  }
  if (typeof routerSocketPath !== "string" || !routerSocketPath.startsWith("/")) {
    throw new Error("routerSocketPath must be an absolute path");
  }
  return [
    `ANTHROPIC_BASE_URL:${JSON.stringify(routerBaseUrl)}`,
    `ANTHROPIC_UNIX_SOCKET:${JSON.stringify(routerSocketPath)}`,
    `ANTHROPIC_CUSTOM_MODEL_OPTION:"deepseek-v4-pro[1m]"`,
    `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME:"DeepSeek V4 Pro (1M)"`,
    `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION:"DeepSeek official Anthropic-compatible API"`,
    `ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:"effort,max_effort,adaptive_thinking,context_management"`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL:"deepseek-v4-flash"`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME:"DeepSeek V4 Flash"`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION:"DeepSeek official fast model"`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:"effort,max_effort,adaptive_thinking"`,
  ];
}

export function buildEnvironmentPatch(options) {
  return environmentPatchEntries(options).join(",");
}

export function buildModelLabelPatch(file, from) {
  const script = `(()=>{if(globalThis.__CLAUDE_HYBRID_MODEL_LABELS__)return;globalThis.__CLAUDE_HYBRID_MODEL_LABELS__=!0;const labels=new Map(${JSON.stringify(MODEL_LABEL_REWRITES)});const rewriteText=node=>{const current=node.nodeValue??"",trimmed=current.trim(),replacement=labels.get(trimmed);if(replacement)node.nodeValue=current.replace(trimmed,replacement)};const rewrite=root=>{if(!root)return;if(root.nodeType===Node.TEXT_NODE){rewriteText(root);return}const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())rewriteText(node)};const start=()=>{rewrite(document.body);new MutationObserver(records=>{for(const record of records){if(record.type==="characterData")rewriteText(record.target);for(const node of record.addedNodes)rewrite(node)}}).observe(document.body,{subtree:!0,childList:!0,characterData:!0})};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",start,{once:!0}):start()})()`;
  const match = from.match(/,([A-Za-z_$][\w$]*)\}$/);
  if (!match) {
    throw new Error("Claude web view patch anchor has an unexpected shape");
  }
  const view = match[1];
  const handler = `${view}.webContents.on("dom-ready",()=>{${view}&&!${view}.webContents.isDestroyed()&&${view}.webContents.executeJavaScript(${JSON.stringify(script)},!0).catch(()=>{})})`;
  return {
    file,
    from,
    // Drop the trailing ",<view>}" then reattach handler + return value.
    to: `${from.slice(0, -(view.length + 2))},${handler},${view}}`,
  };
}

function updateInfoPlist(plistPath, headerSha256, displayName, userDataDir, patchVersion) {
  const script = `
import json, plistlib, sys
path, header_sha = sys.argv[1], sys.argv[2]
with open(path, "rb") as f:
    data = plistlib.load(f)
data["CFBundleDisplayName"] = sys.argv[3]
data["ClaudeHybridPatchVersion"] = sys.argv[5]
data["LSEnvironment"] = {
    "CLAUDE_USER_DATA_DIR": sys.argv[4],
    "DISABLE_AUTOUPDATER": "1",
    "MallocNanoZone": "0",
}
data["ElectronAsarIntegrity"] = {
    "Resources/app.asar": {
        "algorithm": "SHA256",
        "hash": header_sha,
    }
}
with open(path, "wb") as f:
    plistlib.dump(data, f)
`;
  run("/usr/bin/python3", ["-c", script, plistPath, headerSha256, displayName, userDataDir, patchVersion]);
}

function updatePatchVersion(plistPath, patchVersion) {
  const script = `
import plistlib, sys
path, patch_version = sys.argv[1], sys.argv[2]
with open(path, "rb") as f:
    data = plistlib.load(f)
data["ClaudeHybridPatchVersion"] = patch_version
with open(path, "wb") as f:
    plistlib.dump(data, f)
`;
  run("/usr/bin/python3", ["-c", script, plistPath, patchVersion]);
}

export async function migrateClaudeHybridPatchVersion({ targetApp, patchVersion }) {
  const stageApp = `${targetApp}.stage-metadata-${process.pid}.app`;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const backupPath = `${targetApp}.before-patch-version-${timestamp}`;

  try {
    await access(stageApp, constants.F_OK).then(
      async () => {
        throw new Error(`Metadata staging app already exists: ${stageApp}`);
      },
      () => {},
    );
    // The installed Hybrid already has valid ad-hoc nested signatures. Clone it,
    // change only the outer plist, and re-sign only the outer bundle so a metadata
    // migration does not rewrite the 479 MB Electron framework on a low-disk host.
    run("/bin/cp", ["-cRp", targetApp, stageApp]);
    updatePatchVersion(join(stageApp, "Contents/Info.plist"), patchVersion);
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--preserve-metadata=identifier",
      stageApp,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", stageApp]);

    await rename(targetApp, backupPath);
    try {
      await rename(stageApp, targetApp);
    } catch (error) {
      await rename(backupPath, targetApp);
      throw error;
    }
    return { targetApp, backupPath, patchVersion, mode: "metadata-migration" };
  } catch (error) {
    await rm(stageApp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function patchClaudeApp({
  sourceApp,
  targetApp,
  routerBaseUrl,
  routerSocketPath,
  patchFile,
  patchFrom,
  modelLabelPatchFile,
  modelLabelPatchFrom,
  userDataDir,
  patchVersion,
}) {
  const sourceAsar = join(sourceApp, "Contents/Resources/app.asar");
  await access(sourceAsar, constants.R_OK);

  const stageApp = `${targetApp}.stage-${process.pid}.app`;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  let backupPath = null;

  try {
    await mkdir(dirname(stageApp), { recursive: true });
    await access(stageApp, constants.F_OK).then(
      async () => {
        throw new Error(`Staging app already exists: ${stageApp}`);
      },
      () => {},
    );

    // APFS clone-on-write keeps installs viable on machines with limited free space.
    // The staged files remain independently writable when the asar/plist/signature changes.
    run("/bin/cp", ["-cRp", sourceApp, stageApp]);

    const stageAsar = join(stageApp, "Contents/Resources/app.asar");
    const environmentPatch = buildEnvironmentPatch({ routerBaseUrl, routerSocketPath });
    const patches = [
      {
        file: patchFile,
        from: patchFrom,
        to: environmentPatch,
      },
      buildModelLabelPatch(modelLabelPatchFile, modelLabelPatchFrom),
    ];
    const repackResult = await repackAsar({
      asarPath: stageAsar,
      outputPath: stageAsar,
      patches,
    });

    const plistPath = join(stageApp, "Contents/Info.plist");
    updateInfoPlist(plistPath, repackResult.headerSha256, "Claude", userDataDir, patchVersion);

    run("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--preserve-metadata=identifier",
      stageApp,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", stageApp]);

    const finalHeader = await readAsarHeader(stageAsar);
    if (finalHeader.headerSha256 !== repackResult.headerSha256) {
      throw new Error("Patched asar header hash does not match the staged bundle");
    }

    try {
      await access(targetApp, constants.F_OK);
      backupPath = `${targetApp}.before-deepseek-${timestamp}`;
      await rename(targetApp, backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stageApp, targetApp);
    return {
      targetApp,
      backupPath,
      headerSha256: repackResult.headerSha256,
      packedFiles: repackResult.packedFiles,
      totalFiles: repackResult.totalFiles,
    };
  } catch (error) {
    await rm(stageApp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
