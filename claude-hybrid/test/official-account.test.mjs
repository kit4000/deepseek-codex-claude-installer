import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  firstPartyDesktopConfig,
  isManagedDeepSeekOnlyLibrary,
  releaseDeepSeekOnlyOfficialAccount,
} from "../src/official-account.mjs";

test("only a DeepSeek-only gateway library is eligible to leave 3p mode", () => {
  assert.equal(isManagedDeepSeekOnlyLibrary([]), false);
  assert.equal(isManagedDeepSeekOnlyLibrary([
    { inferenceGatewayBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL },
  ]), true);
  assert.equal(isManagedDeepSeekOnlyLibrary([
    { inferenceGatewayBaseUrl: "https://example.internal/anthropic" },
  ]), false);
  assert.equal(isManagedDeepSeekOnlyLibrary([
    { inferenceGatewayBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL },
    { inferenceGatewayBaseUrl: "https://example.internal/anthropic" },
  ]), false);
});

test("first-party switch preserves the rest of the desktop config", () => {
  assert.deepEqual(
    firstPartyDesktopConfig({ deploymentMode: "3p", preferences: { theme: "dark" } }),
    { deploymentMode: "1p", preferences: { theme: "dark" } },
  );
  assert.equal(firstPartyDesktopConfig({ deploymentMode: "1p" }), null);
});

test("managed DeepSeek 3p config returns Official to the first-party account", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-official-"));
  const support = join(home, "Library/Application Support/Claude-3p");
  const library = join(support, "configLibrary");
  await mkdir(library, { recursive: true });
  const desktopPath = join(support, "claude_desktop_config.json");
  await writeFile(desktopPath, `${JSON.stringify({ deploymentMode: "3p", preferences: { a: 1 } }, null, 2)}\n`);
  await writeFile(join(library, "applied.json"), JSON.stringify({
    inferenceGatewayBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    inferenceModels: [{ name: "claude-opus-4-6" }],
  }));
  try {
    const result = await releaseDeepSeekOnlyOfficialAccount(home);
    assert.equal(result.changed, true);
    assert.equal(result.deploymentMode, "1p");
    const updated = JSON.parse(await readFile(desktopPath, "utf8"));
    assert.equal(updated.deploymentMode, "1p");
    assert.equal(updated.preferences.a, 1);
    const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
    assert.equal(backup.deploymentMode, "3p");
    const libraryStillThere = JSON.parse(await readFile(join(library, "applied.json"), "utf8"));
    assert.equal(libraryStillThere.inferenceGatewayBaseUrl, DEEPSEEK_ANTHROPIC_BASE_URL);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unrelated 3p config is left unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-official-"));
  const support = join(home, "Library/Application Support/Claude-3p/configLibrary");
  await mkdir(support, { recursive: true });
  const desktopPath = join(home, "Library/Application Support/Claude-3p/claude_desktop_config.json");
  await writeFile(desktopPath, JSON.stringify({ deploymentMode: "3p" }));
  await writeFile(join(support, "work.json"), JSON.stringify({
    inferenceGatewayBaseUrl: "https://bedrock.example/anthropic",
  }));
  try {
    const result = await releaseDeepSeekOnlyOfficialAccount(home);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "unmanaged-3p");
    assert.equal(JSON.parse(await readFile(desktopPath, "utf8")).deploymentMode, "3p");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
