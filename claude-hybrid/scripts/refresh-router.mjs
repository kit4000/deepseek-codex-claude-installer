#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestUnix } from "../src/router.mjs";
import { overlayInstallerModels } from "../src/update-plan.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const installerConfigPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const installerConfig = JSON.parse(await readFile(installerConfigPath, "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);
const managedDir = process.env.CLAUDE_HYBRID_RUNTIME_DIR ?? `${home}/Library/Application Support/Claude Hybrid`;
const runtimeConfigPath = process.env.CLAUDE_HYBRID_RUNTIME_CONFIG ?? join(managedDir, "config.json");
const routerPath = join(managedDir, "router.mjs");
const plistPath = expand(installerConfig.launchAgent.plistPath);
const domain = `gui/${process.getuid()}`;
const label = installerConfig.launchAgent.label;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
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
  throw new Error("Claude Hybrid router did not become healthy after refresh");
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
  throw new Error("Claude Hybrid router unix socket did not become healthy after refresh");
}

const runtimeConfig = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
const refreshed = overlayInstallerModels(runtimeConfig, installerConfig);
await mkdir(managedDir, { recursive: true });
for (const moduleName of ["router.mjs", "openai-messages.mjs"]) {
  await writeFile(join(managedDir, moduleName), await readFile(resolve(projectRoot, "src", moduleName), "utf8"), { mode: 0o700 });
}
await writeFile(runtimeConfigPath, JSON.stringify(refreshed, null, 2), { mode: 0o600 });
await chmod(routerPath, 0o700);

run("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "ignore" });
await waitForHealth(installerConfig.router.port);
await waitForUnix(expand(refreshed.router?.socketPath ?? installerConfig.router.socketPath));

console.log(JSON.stringify({
  ok: true,
  refreshed: ["router.mjs", "openai-messages.mjs", "models"],
  runtimeConfigPath,
  plistPath,
}, null, 2));
