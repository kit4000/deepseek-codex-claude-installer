import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderClaudeWrapper } from "../src/claude-config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const binDirectory = resolve(process.env.DEEPSEEK_BIN_DIR ?? `${process.env.HOME}/.local/bin`);
const wrapperPath = resolve(binDirectory, "claude-deepseek");
const launcherPath = resolve(projectRoot, "scripts/claude-deepseek.mjs");
const marker = "# Managed by deepseek-handoff.";

if (process.platform !== "darwin") throw new Error("The Keychain-backed Claude launcher currently supports macOS only");
if (!process.env.HOME) throw new Error("HOME is required");
await access(launcherPath, constants.R_OK);
await mkdir(binDirectory, { recursive: true });

let existing = "";
try {
  existing = await readFile(wrapperPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing && !existing.includes(marker)) {
  throw new Error(`Refusing to overwrite an unmanaged executable: ${wrapperPath}`);
}

const temporaryPath = `${wrapperPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, renderClaudeWrapper(process.execPath, launcherPath), { mode: 0o755 });
await rename(temporaryPath, wrapperPath);
await chmod(wrapperPath, 0o755);

console.log(JSON.stringify({
  wrapperPath,
  launcherPath,
  claudeSettingsChanged: false,
  note: `${binDirectory} must be on PATH`,
}));
