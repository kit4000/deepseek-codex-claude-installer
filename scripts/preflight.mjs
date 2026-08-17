import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeRoot, codexRoot, projectRoot, runNode } from "./lib.mjs";
import {
  hasHybridMarker,
  inspectAppleSignature,
  isDefaultClaudeLayout,
  pathExists,
} from "../claude-hybrid/src/app-layout.mjs";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const claudeConfig = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);
const sourceApp = process.env.CLAUDE_HYBRID_SOURCE ?? expand(claudeConfig.app.source);
const targetApp = process.env.CLAUDE_HYBRID_TARGET ?? expand(claudeConfig.app.target);
const defaultLayout = isDefaultClaudeLayout({ sourceApp, targetApp, home });
const targetExists = await pathExists(targetApp);
const targetCanBecomeOfficial = defaultLayout
  && targetExists
  && !hasHybridMarker(targetApp)
  && inspectAppleSignature(targetApp).ok;
const inspectionSource = targetCanBecomeOfficial ? targetApp : sourceApp;
const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
}

async function check(name, action, { warn = false } = {}) {
  try {
    record(name, "pass", await action());
  } catch (error) {
    record(name, warn ? "warn" : "fail", error.message);
  }
}

runNode(codexRoot, "scripts/preflight.mjs", [], {
  env: { DEEPSEEK_PREFLIGHT_SCOPE: "codex" },
});

await check("integrated bundle path", async () => {
  if (projectRoot.startsWith("/tmp/") || projectRoot.startsWith("/private/tmp/")) {
    throw new Error("Clone or move the installer to a permanent directory before installation; /tmp is not allowed");
  }
  return projectRoot;
});

await check("Claude official application", async () => {
  await access(resolve(inspectionSource, "Contents/Resources/app.asar"), constants.R_OK);
  const signature = inspectAppleSignature(inspectionSource);
  if (!signature.ok || hasHybridMarker(inspectionSource)) {
    throw new Error(`The Claude source is not pristine and Apple-signed: ${inspectionSource}`);
  }
  return targetCanBecomeOfficial
    ? `${inspectionSource} is pristine and will move to ${sourceApp} before Hybrid is built`
    : `${sourceApp} is the pristine Apple-signed source and will not be patched`;
});

await check("Claude version-specific patch anchors", async () => {
  const { readAsarFile } = await import(pathToFileURL(resolve(claudeRoot, "src/asar-repack.mjs")));
  const asarPath = resolve(inspectionSource, "Contents/Resources/app.asar");
  const environmentSource = await readAsarFile(asarPath, claudeConfig.app.patchFile);
  const labelSource = await readAsarFile(asarPath, claudeConfig.app.modelLabelPatchFile);
  if (!environmentSource?.includes(claudeConfig.app.patchFrom)) {
    throw new Error(`Claude Code environment anchor is absent in ${claudeConfig.app.patchFile}; stop instead of fuzzy-patching`);
  }
  if (!labelSource?.includes(claudeConfig.app.modelLabelPatchFrom)) {
    throw new Error(`Claude picker anchor is absent in ${claudeConfig.app.modelLabelPatchFile}; stop instead of fuzzy-patching`);
  }
  return "both exact anchors are present";
});

await check("Claude extra slot contract", async () => {
  const aliases = claudeConfig.models.external.flatMap((entry) => entry.aliases ?? []).sort();
  const expected = [
    "claude-haiku-4-5-external-flash",
    "claude-opus-4-5-external-pro",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ];
  if (JSON.stringify(aliases) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected external aliases: ${aliases.join(", ")}`);
  }
  if (claudeConfig.models.external.some((entry) => entry.provider === "openai") || claudeConfig.openai) {
    throw new Error("Claude Hybrid picker must not route ChatGPT subscription models through the OpenAI API");
  }
  const { MODEL_LABEL_REWRITES } = await import(pathToFileURL(resolve(claudeRoot, "src/app-patch.mjs")));
  const fromLabels = MODEL_LABEL_REWRITES.map(([from]) => from);
  for (const forbidden of ["Fable 5", "Opus 5", "Sonnet 5", "Haiku 4.5", "Opus 4.5", "Sonnet 4.5", "Opus 4.8", "Opus 4.7"]) {
    if (fromLabels.includes(forbidden)) {
      throw new Error(`${forbidden} is targeted by the label patch`);
    }
  }
  if (!fromLabels.includes("Opus 4.6") || !fromLabels.includes("Sonnet 4.6")) {
    throw new Error("DeepSeek label rewrites must target Opus 4.6 and Sonnet 4.6");
  }
  return "4.6 DeepSeek only; Fable 5 / Opus 4.8 / Opus 5 / Sonnet 5 / Haiku stay native";
});

await check("Claude app layout", async () => {
  const userDataDir = expand(claudeConfig.app.userDataDir);
  if (resolve(targetApp) === resolve(sourceApp)) throw new Error("Hybrid target points to the source app");
  const allowedTargets = new Set(["/Applications/Claude.app"]);
  if (!allowedTargets.has(targetApp) && !process.env.CLAUDE_HYBRID_TARGET) {
    throw new Error(`Unexpected Hybrid target: ${targetApp}`);
  }
  if (userDataDir !== join(home, "Library/Application Support/Claude")) {
    throw new Error("Hybrid does not share the official per-user session directory");
  }
  return "daily Hybrid is /Applications/Claude.app; pristine source is separate and per-user sessions are shared";
});

await check("Claude Hybrid router port", async () => {
  const response = await fetch("http://127.0.0.1:10102/healthz", { signal: AbortSignal.timeout(750) });
  const body = response.ok ? await response.json() : undefined;
  if (body?.ok !== true || body?.provider !== "claude-hybrid") {
    throw new Error("port 10102 is occupied by an unexpected service");
  }
  return "expected router is already running";
}, { warn: true });

await check("shared DeepSeek credential", async () => {
  const result = spawnSync("/usr/bin/security", [
    "find-generic-password",
    "-s", "com.local.codex-native-model-router.deepseek",
    "-a", "api-key",
    "-w",
  ], { stdio: "ignore", timeout: 5000 });
  if (result.status !== 0) throw new Error("not stored yet; run npm run store-key");
  return "present in this user's Keychain; value was not displayed";
}, { warn: true });

console.log(JSON.stringify({ ok: !results.some((entry) => entry.status === "fail"), results }, null, 2));
if (results.some((entry) => entry.status === "fail")) process.exitCode = 1;
