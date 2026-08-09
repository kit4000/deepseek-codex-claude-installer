import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

const BLOCK_SIZE = 4 * 1024 * 1024;

function align4(value) {
  return (value + 3) & ~3;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function integrityFor(content) {
  const blocks = [];
  for (let offset = 0; offset < content.length; offset += BLOCK_SIZE) {
    blocks.push(sha256(content.subarray(offset, offset + BLOCK_SIZE)));
  }
  return {
    algorithm: "SHA256",
    hash: sha256(content),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function collectEntries(node, prefix, entries) {
  if (!node.files) return;
  for (const [name, child] of Object.entries(node.files)) {
    const path = `${prefix}/${name}`;
    if (child.files) {
      collectEntries(child, path, entries);
    } else if (typeof child.offset === "string") {
      entries.push({ path, child, packed: true });
    } else {
      entries.push({ path, child, packed: false });
    }
  }
}

function replaceExactlyOnce(content, from, to, description) {
  const first = content.indexOf(from);
  if (first < 0) throw new Error(`Patch source not found: ${description}`);
  const second = content.indexOf(from, first + from.length);
  if (second >= 0) throw new Error(`Patch source matched more than once: ${description}`);
  return Buffer.concat([
    content.subarray(0, first),
    to,
    content.subarray(first + from.length),
  ]);
}

export async function repackAsar({ asarPath, outputPath, patches }) {
  const original = await readFile(asarPath);
  const originalJsonLength = original.readUInt32LE(12);
  const header = JSON.parse(original.subarray(16, 16 + originalJsonLength).toString("utf8"));
  const base = 8 + original.readUInt32LE(4);

  const entries = [];
  collectEntries(header, "", entries);

  for (const entry of entries) {
    if (!entry.packed) continue;
    entry.content = original.subarray(
      base + Number(entry.child.offset),
      base + Number(entry.child.offset) + entry.child.size,
    );
  }

  for (const patch of patches) {
    const entry = entries.find((candidate) => candidate.path === patch.file && candidate.packed);
    if (!entry) throw new Error(`Patch target not found in asar: ${patch.file}`);
    const from = Buffer.from(patch.from, "utf8");
    const to = Buffer.from(patch.to, "utf8");
    entry.content = replaceExactlyOnce(
      entry.content,
      from,
      to,
      `${patch.file}: ${patch.from}`,
    );
    entry.child.size = entry.content.length;
    entry.child.integrity = integrityFor(entry.content);
  }

  const chunks = [];
  let cursor = 0;
  for (const entry of entries) {
    if (!entry.packed) continue;
    entry.child.offset = String(cursor);
    cursor += entry.content.length;
    chunks.push(entry.content);
  }

  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const headerSize = align4(8 + headerBuffer.length);
  const innerSize = align4(4 + headerBuffer.length);
  const outputHeader = Buffer.alloc(8 + headerSize);
  outputHeader.writeUInt32LE(4, 0);
  outputHeader.writeUInt32LE(headerSize, 4);
  outputHeader.writeUInt32LE(innerSize, 8);
  outputHeader.writeUInt32LE(headerBuffer.length, 12);
  headerBuffer.copy(outputHeader, 16);

  const output = Buffer.concat([outputHeader, ...chunks]);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, output);
  await rename(temporaryPath, outputPath);

  return {
    headerSha256: sha256(headerBuffer),
    packedFiles: entries.filter((entry) => entry.packed).length,
    totalFiles: entries.length,
  };
}

export async function readAsarHeader(asarPath) {
  const data = await readFile(asarPath);
  const headerSize = data.readUInt32LE(12);
  return {
    headerSha256: sha256(data.subarray(16, 16 + headerSize)),
  };
}

export async function readAsarFile(asarPath, targetPath) {
  const data = await readFile(asarPath);
  const jsonLength = data.readUInt32LE(12);
  const header = JSON.parse(data.subarray(16, 16 + jsonLength).toString("utf8"));
  const base = 8 + data.readUInt32LE(4);
  const segments = String(targetPath).split("/").filter(Boolean);
  let node = header;
  for (const segment of segments) {
    node = node.files?.[segment];
    if (!node) return null;
  }
  if (node.files || typeof node.offset !== "string") return null;
  return data.subarray(base + Number(node.offset), base + Number(node.offset) + node.size);
}
