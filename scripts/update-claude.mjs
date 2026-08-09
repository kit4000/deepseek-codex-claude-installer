import { claudeRoot, runNode } from "./lib.mjs";

runNode(claudeRoot, "scripts/update.mjs", process.argv.slice(2));
