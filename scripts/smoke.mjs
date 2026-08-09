import { claudeRoot, codexRoot, projectRoot, requireFlag, runNode } from "./lib.mjs";

requireFlag(
  "--allow-billing",
  "Billing smoke tests are disabled by default. Obtain explicit user approval, then rerun with --allow-billing.",
);

const args = new Set(process.argv.slice(2));
const codexOnly = args.has("--codex-only");
const claudeOnly = args.has("--claude-only");
if (codexOnly && claudeOnly) throw new Error("Choose only one of --codex-only or --claude-only");

runNode(projectRoot, "scripts/verify.mjs");
if (!claudeOnly) {
  runNode(codexRoot, "scripts/smoke.mjs", ["deepseek/deepseek-v4-flash", "max"]);
}
if (!codexOnly) runNode(claudeRoot, "scripts/smoke.mjs");

console.log("Approved billable DeepSeek smoke tests completed successfully.");
