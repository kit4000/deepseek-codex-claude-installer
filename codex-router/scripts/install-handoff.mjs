import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const steps = [
  "preflight.mjs",
  "install.mjs",
  "install-claude.mjs",
  "verify-installation.mjs",
];

for (const script of steps) {
  const path = resolve(projectRoot, "scripts", script);
  const result = spawnSync(process.execPath, [path], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${script} was interrupted by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status}`);
}

console.log("DeepSeek handoff installation and non-billable verification completed.");
