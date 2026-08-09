import { codexRoot, runNode } from "./lib.mjs";

if (process.platform !== "darwin") throw new Error("macOS Keychain is required");
runNode(codexRoot, "scripts/store-deepseek-key.mjs");
console.log("The same per-user Keychain item will be used by Codex and Claude Hybrid.");
