import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeRoot, codexRoot, projectRoot } from "./lib.mjs";

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputPath = resolve(process.argv[2] ?? `/tmp/deepseek-codex-claude-${timestamp}.tar.gz`);
const relativeOutput = relative(projectRoot, outputPath);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !relativeOutput.startsWith("/"))) {
  throw new Error("Write the distribution archive outside the installer source directory");
}
try {
  await stat(outputPath);
  throw new Error(`Refusing to overwrite an existing archive: ${outputPath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const rootFiles = JSON.parse(await readFile(resolve(projectRoot, "config/integrated-files.json"), "utf8"));
const codexFiles = JSON.parse(await readFile(resolve(codexRoot, "config/handoff-files.json"), "utf8"));
const claudeFiles = JSON.parse(await readFile(resolve(claudeRoot, "config/hybrid-files.json"), "utf8"));
const { validateHandoffManifest } = await import(pathToFileURL(resolve(codexRoot, "src/handoff.mjs")));
validateHandoffManifest(codexFiles);
if (!Array.isArray(rootFiles) || rootFiles.length === 0 || !Array.isArray(claudeFiles) || claudeFiles.length === 0) {
  throw new Error("An archive allowlist is empty or invalid");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-integrated-"));
const bundleName = "deepseek-codex-claude-installer";
const stageRoot = join(temporaryRoot, bundleName);
const archivedFiles = [];
const hashes = {};
const probableSecret = /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/;

async function copySelected(sourceRoot, destinationPrefix, files) {
  for (const file of files) {
    if (typeof file !== "string" || !file || file.startsWith("/") || file.includes("..")) {
      throw new Error(`Unsafe archive path: ${file}`);
    }
    const source = resolve(sourceRoot, file);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`Archive entry is not a regular file: ${source}`);
    const contents = await readFile(source);
    if (probableSecret.test(contents.toString("utf8"))) {
      throw new Error(`Probable API credential found in archive entry: ${destinationPrefix}${file}`);
    }
    const destinationRelative = `${destinationPrefix}${file}`;
    const destination = resolve(stageRoot, destinationRelative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    archivedFiles.push(destinationRelative);
    hashes[destinationRelative] = createHash("sha256").update(contents).digest("hex");
  }
}

try {
  await copySelected(projectRoot, "", rootFiles);
  await copySelected(codexRoot, "codex-router/", codexFiles);
  await copySelected(claudeRoot, "claude-hybrid/", claudeFiles);

  const manifest = {
    formatVersion: 1,
    purpose: "Codex native plus DeepSeek routing, callable DeepSeek V4 agent, and updateable Claude Hybrid 4.6-slot installation",
    keychain: {
      copied: false,
      service: "com.local.codex-native-model-router.deepseek",
      account: "api-key",
    },
    protected: [
      "~/Applications/Claude Official.app contents and Apple signature",
      "/Applications/Claude.app daily Hybrid identity and disabled updater",
      "Codex and Claude session stores",
      "Fable 5 and Opus 4.8 native model slots",
      "Main model selection and global subagent defaults",
    ],
    files: hashes,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolve(stageRoot, "INSTALLER_MANIFEST.json"), manifestText, { mode: 0o600 });
  archivedFiles.push("INSTALLER_MANIFEST.json");

  await mkdir(dirname(outputPath), { recursive: true });
  const archived = spawnSync("/usr/bin/tar", ["-czf", outputPath, "-C", temporaryRoot, bundleName], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (archived.error) throw archived.error;
  if (archived.status !== 0) throw new Error(`tar failed: ${archived.stderr.trim()}`);
  await chmod(outputPath, 0o600);

  const sha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  console.log(JSON.stringify({ archivePath: outputPath, sha256, files: archivedFiles.length }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
