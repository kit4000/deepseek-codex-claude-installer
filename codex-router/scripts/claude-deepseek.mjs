import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeEnvironment,
  parseClaudeLauncherArgs,
  publicClaudeConfiguration,
  validateClaudeConfig,
} from "../src/claude-config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(
  process.env.DEEPSEEK_CLAUDE_CONFIG ?? resolve(projectRoot, "config/claude-deepseek.json"),
);
const config = validateClaudeConfig(JSON.parse(await readFile(configPath, "utf8")));
const parsed = parseClaudeLauncherArgs(process.argv.slice(2), config);

const credential = spawnSync("/usr/bin/security", [
  "find-generic-password",
  "-s", config.keychain.service,
  "-a", config.keychain.account,
  "-w",
], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
const token = credential.status === 0 ? credential.stdout.trim() : "";

if (parsed.printConfig) {
  console.log(JSON.stringify(
    publicClaudeConfiguration(config, parsed.selectedModel, Boolean(token), process.env),
    null,
    2,
  ));
  process.exit(token ? 0 : 1);
}

if (!token) {
  throw new Error("DeepSeek API key is missing from macOS Keychain; run npm run store-deepseek-key");
}

const claudeExecutable = process.env.DEEPSEEK_CLAUDE_BIN ?? "claude";
if (/(^|\/)claude-deepseek$/.test(claudeExecutable)) {
  throw new Error("DEEPSEEK_CLAUDE_BIN must point to the original Claude Code executable");
}
const child = spawnSync(claudeExecutable, parsed.claudeArgs, {
  env: buildClaudeEnvironment(process.env, config, token, parsed.selectedModel),
  stdio: "inherit",
});
if (child.error) {
  if (child.error.code === "ENOENT") {
    throw new Error("Claude Code was not found on PATH; install or upgrade the official claude command first");
  }
  throw child.error;
}
if (child.signal) {
  const signalNumber = { SIGINT: 2, SIGTERM: 15 }[child.signal] ?? 1;
  process.exitCode = 128 + signalNumber;
} else {
  process.exitCode = child.status ?? 1;
}
