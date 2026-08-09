import { spawnSync } from "node:child_process";

const service = "com.local.codex-native-model-router.deepseek";
const account = "api-key";
const result = spawnSync("/usr/bin/security", [
  "add-generic-password",
  "-U",
  "-a", account,
  "-s", service,
  "-l", "DeepSeek API key for Codex and Claude launchers",
  "-w",
], { stdio: "inherit" });

if (result.status !== 0) {
  throw new Error("DeepSeek API key was not stored in the login keychain");
}

console.log("DeepSeek API key was stored in macOS Keychain (value not displayed).");
