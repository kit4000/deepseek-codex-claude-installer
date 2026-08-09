import { resolve } from "node:path";
import { claudeRoot, codexRoot, projectRoot, run } from "./lib.mjs";

run(process.execPath, ["--test"], { cwd: codexRoot });
run(process.execPath, ["--test"], { cwd: claudeRoot });
run(process.execPath, [
  "--test",
  resolve(projectRoot, "test/extensions.test.mjs"),
  resolve(projectRoot, "test/integration.test.mjs"),
], { cwd: projectRoot });

console.log("All Codex router, Claude Hybrid, and integrated-installer tests passed.");
