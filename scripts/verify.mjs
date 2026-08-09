import { claudeRoot, codexRoot, projectRoot, runNode } from "./lib.mjs";

runNode(codexRoot, "scripts/verify-installation.mjs", [], {
  env: { DEEPSEEK_VERIFY_SCOPE: "codex" },
});
runNode(claudeRoot, "scripts/verify.mjs");
runNode(projectRoot, "scripts/verify-extensions.mjs");

console.log("Non-billable Codex, Claude Hybrid, updater-skill, and DeepSeek subagent verification completed.");
