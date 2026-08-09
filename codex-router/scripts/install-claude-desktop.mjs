import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaudeConfig } from "../src/claude-config.mjs";
import {
  buildClaudeDesktopGatewayConfig,
  CREDENTIAL_HELPER_MARKER,
  newClaudeDesktopConfigLibrary,
  renderClaudeDesktopCredentialHelper,
} from "../src/claude-desktop-config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(projectRoot, "config/claude-deepseek.json");
const templatePath = resolve(projectRoot, "config/claude-desktop-gateway.template.json");
const binDirectory = resolve(process.env.DEEPSEEK_BIN_DIR ?? `${process.env.HOME}/.local/bin`);
const helperPath = resolve(binDirectory, "claude-desktop-credential-helper");
const appSupport = resolve(
  process.env.CLAUDE_USER_DATA_DIR
    ?? `${process.env.HOME}/Library/Application Support/Claude-3p`,
);
const configLibraryDir = join(appSupport, "configLibrary");
const desktopConfigPath = join(appSupport, "claude_desktop_config.json");
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");

if (process.platform !== "darwin") {
  throw new Error("The Keychain-backed Claude Desktop setup currently supports macOS only");
}
if (!process.env.HOME) throw new Error("HOME is required");

const config = validateClaudeConfig(JSON.parse(await readFile(configPath, "utf8")));
const template = JSON.parse(await readFile(templatePath, "utf8"));
const gatewayConfig = buildClaudeDesktopGatewayConfig(template, helperPath);
const helper = renderClaudeDesktopCredentialHelper(config.keychain);
const { uuid, meta, config: libraryConfig } = newClaudeDesktopConfigLibrary(gatewayConfig);

await mkdir(binDirectory, { recursive: true });

let existingHelper = "";
try {
  existingHelper = await readFile(helperPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existingHelper && !existingHelper.includes(CREDENTIAL_HELPER_MARKER)) {
  throw new Error(`Refusing to overwrite an unmanaged executable: ${helperPath}`);
}

const helperTemporaryPath = `${helperPath}.tmp-${process.pid}`;
await writeFile(helperTemporaryPath, helper, { mode: 0o700 });
await rename(helperTemporaryPath, helperPath);
await chmod(helperPath, 0o700);

async function backupIfExists(path) {
  try {
    await access(path, constants.F_OK);
  } catch {
    return null;
  }
  const backupPath = `${path}.before-deepseek-${timestamp}`;
  await rename(path, backupPath);
  return backupPath;
}

const backups = {
  desktopConfig: await backupIfExists(desktopConfigPath),
  configLibrary: await backupIfExists(configLibraryDir),
};

let preferences = {};
if (backups.desktopConfig) {
  try {
    const previous = JSON.parse(await readFile(backups.desktopConfig, "utf8"));
    if (previous && typeof previous.preferences === "object" && !Array.isArray(previous.preferences)) {
      preferences = previous.preferences;
    }
  } catch {
    // A corrupt previous file is replaced; the original remains in the backup path.
  }
}

await mkdir(appSupport, { recursive: true });
await writeFile(
  desktopConfigPath,
  JSON.stringify({ deploymentMode: "3p", preferences }, null, 2),
  { mode: 0o600 },
);
await mkdir(configLibraryDir, { recursive: true, mode: 0o700 });
await writeFile(join(configLibraryDir, "_meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
await writeFile(join(configLibraryDir, `${uuid}.json`), JSON.stringify(libraryConfig, null, 2), {
  mode: 0o600,
});

console.log(JSON.stringify({
  helperPath,
  configLibraryDir,
  appliedId: uuid,
  backups,
  note: "Fully quit and relaunch Claude Desktop. The DeepSeek key stays in macOS Keychain.",
}, null, 2));
