import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const { service, account } = config.openai.keychain;

const result = spawnSync("/usr/bin/security", [
  "add-generic-password",
  "-U",
  "-a", account,
  "-s", service,
  "-l", "OpenAI API key for Claude Hybrid",
  "-w",
], { stdio: "inherit" });

if (result.status !== 0) {
  throw new Error("OpenAI API key was not stored in the login keychain");
}

console.log("OpenAI API key was stored in macOS Keychain (value not displayed).");
