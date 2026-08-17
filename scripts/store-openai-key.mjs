import { claudeRoot, runNode } from "./lib.mjs";

if (process.platform !== "darwin") throw new Error("macOS Keychain is required");
runNode(claudeRoot, "scripts/store-openai-key.mjs");
console.log("The OpenAI Keychain item is used only by Claude Hybrid GPT-5.6 routes.");
