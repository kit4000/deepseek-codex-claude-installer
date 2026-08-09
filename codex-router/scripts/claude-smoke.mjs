import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryClaudeHome = await mkdtemp(join(tmpdir(), "deepseek-claude-smoke-"));
let report;

try {
  const result = spawnSync(process.execPath, [
    resolve(projectRoot, "scripts/claude-deepseek.mjs"),
    "--deepseek-model", "flash",
    "-p",
    "Reply with only CLAUDE_DEEPSEEK_OK",
    "--output-format", "text",
  ], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: temporaryClaudeHome },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const completed = result.status === 0 && output === "CLAUDE_DEEPSEEK_OK";
  report = {
    model: "deepseek-v4-flash",
    status: result.status,
    completed,
    output,
    ...(completed ? {} : { error: result.stderr.trim().slice(0, 1000) }),
  };
  if (!completed) process.exitCode = 1;
} finally {
  await rm(temporaryClaudeHome, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...report, temporarySessionRemoved: true }));
