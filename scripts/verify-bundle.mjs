import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { projectRoot } from "./lib.mjs";

const bundleRoot = resolve(projectRoot);
const manifestPath = resolve(bundleRoot, "INSTALLER_MANIFEST.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.formatVersion !== 1 || !manifest.files || typeof manifest.files !== "object") {
  throw new Error("Unsupported or invalid INSTALLER_MANIFEST.json");
}
if (manifest.keychain?.copied !== false) throw new Error("Manifest does not declare Keychain exclusion");

let verified = 0;
for (const [relativePath, expected] of Object.entries(manifest.files)) {
  const absolutePath = resolve(bundleRoot, relativePath);
  if (!absolutePath.startsWith(`${bundleRoot}${sep}`)) throw new Error(`Unsafe manifest path: ${relativePath}`);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error(`Manifest entry is not a regular file: ${relativePath}`);
  const actual = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
  if (actual !== expected) throw new Error(`Hash mismatch: ${relativePath}`);
  verified += 1;
}

console.log(JSON.stringify({ ok: true, verified, keychainCopied: false }, null, 2));
