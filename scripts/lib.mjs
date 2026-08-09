import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function locateComponent(environmentName, bundledName, developmentName) {
  if (process.env[environmentName]) return resolve(process.env[environmentName]);
  const bundled = resolve(projectRoot, bundledName);
  if (await exists(bundled)) return bundled;
  const development = resolve(dirname(projectRoot), developmentName);
  if (await exists(development)) return development;
  throw new Error(`Component not found: ${bundledName}`);
}

export const codexRoot = await locateComponent(
  "DEEPSEEK_CODEX_COMPONENT",
  "codex-router",
  "handoff-019fd29c",
);
export const claudeRoot = await locateComponent(
  "DEEPSEEK_CLAUDE_COMPONENT",
  "claude-hybrid",
  "claude-hybrid",
);

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} was interrupted by ${result.signal}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function runNode(root, script, args = [], options = {}) {
  return run(process.execPath, [resolve(root, script), ...args], { ...options, cwd: root });
}

export function requireFlag(flag, message) {
  if (!process.argv.slice(2).includes(flag)) throw new Error(message);
}
