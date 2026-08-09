import { spawnSync } from "node:child_process";
import { claudeRoot, codexRoot, projectRoot, runNode } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const codexOnly = args.has("--codex-only");
const claudeOnly = args.has("--claude-only");
if (codexOnly && claudeOnly) throw new Error("Choose only one of --codex-only or --claude-only");
const installCodex = !claudeOnly;
const installClaude = !codexOnly;

runNode(projectRoot, "scripts/preflight.mjs");

const credential = spawnSync("/usr/bin/security", [
  "find-generic-password",
  "-s", "com.local.codex-native-model-router.deepseek",
  "-a", "api-key",
  "-w",
], { stdio: "ignore", timeout: 5000 });
if (credential.status !== 0) {
  throw new Error("DeepSeek API key is not in this user's Keychain; run npm run store-key first");
}

if (installCodex) runNode(codexRoot, "scripts/install.mjs");
if (installClaude) runNode(claudeRoot, "scripts/install.mjs");
runNode(projectRoot, "scripts/install-extensions.mjs");

if (installCodex && installClaude) {
  runNode(projectRoot, "scripts/verify.mjs");
} else if (installCodex) {
  runNode(codexRoot, "scripts/verify-installation.mjs", [], {
    env: { DEEPSEEK_VERIFY_SCOPE: "codex" },
  });
} else {
  runNode(claudeRoot, "scripts/verify.mjs");
}

console.log(JSON.stringify({
  ok: true,
  installed: { codex: installCodex, claudeHybrid: installClaude },
  next: [
    "Fully quit and reopen Codex Desktop before checking its model menu.",
    ...(installClaude ? [
      "Open Claude from /Applications; this is the daily Hybrid app.",
      "Keep ~/Applications/Claude Official.app pristine and use it only as the update source.",
      "Approve the Claude Safe Storage Keychain prompt by choosing Always Allow.",
      "Confirm that only the Sonnet 4.6 and Opus 4.6 slots show DeepSeek labels.",
    ] : []),
    "Run npm run smoke -- --allow-billing only after explicit billing approval.",
  ],
}, null, 2));
