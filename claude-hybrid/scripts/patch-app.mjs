import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchClaudeApp } from "../src/app-patch.mjs";

function expandHome(value, home) {
  return String(value).replaceAll("<home>", home);
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const home = process.env.HOME ?? "";

const result = await patchClaudeApp({
  sourceApp: process.env.CLAUDE_HYBRID_SOURCE ?? expandHome(config.app.source, home),
  targetApp: process.env.CLAUDE_HYBRID_TARGET ?? expandHome(config.app.target, home),
  routerBaseUrl: process.env.CLAUDE_HYBRID_ROUTER_URL ?? expandHome(config.app.routerBaseUrl, home),
  patchFile: config.app.patchFile,
  patchFrom: config.app.patchFrom,
  modelLabelPatchFile: config.app.modelLabelPatchFile,
  modelLabelPatchFrom: config.app.modelLabelPatchFrom,
  userDataDir: process.env.CLAUDE_HYBRID_USER_DATA_DIR ?? expandHome(config.app.userDataDir, home),
  patchVersion: config.app.patchVersion,
});

console.log(JSON.stringify(result, null, 2));
