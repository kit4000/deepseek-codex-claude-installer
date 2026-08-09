import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHandoffManifest } from "../src/handoff.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputPath = resolve(process.argv[2] ?? `/tmp/deepseek-handoff-${timestamp}.tar.gz`);
const relativeOutput = relative(projectRoot, outputPath);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !relativeOutput.startsWith("/"))) {
  throw new Error("Write the handoff archive outside the source bundle");
}

try {
  await stat(outputPath);
  throw new Error(`Refusing to overwrite an existing archive: ${outputPath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const manifestPath = resolve(projectRoot, "config/handoff-files.json");
const files = validateHandoffManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const probableSecret = /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/;
for (const file of files) {
  const path = resolve(projectRoot, file);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Handoff entry is not a regular file: ${file}`);
  const contents = await readFile(path, "utf8");
  if (probableSecret.test(contents)) throw new Error(`Probable API credential found in handoff file: ${file}`);
}

await mkdir(dirname(outputPath), { recursive: true });
const archived = spawnSync("/usr/bin/tar", ["-czf", outputPath, "-C", projectRoot, ...files], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
});
if (archived.error) throw archived.error;
if (archived.status !== 0) throw new Error(`tar failed: ${archived.stderr.trim()}`);
await chmod(outputPath, 0o600);

const sha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
console.log(JSON.stringify({ archivePath: outputPath, sha256, files: files.length }, null, 2));
