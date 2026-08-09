import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { claudeRoot, codexRoot, projectRoot } from "../scripts/lib.mjs";

test("native GPT restores only router-sealed compactions", async () => {
  const library = await readFile(resolve(codexRoot, "src/lib.mjs"), "utf8");
  const tests = await readFile(resolve(codexRoot, "test/router.test.mjs"), "utf8");
  assert.match(library, /codex-native-model-router:compaction:v1:/);
  assert.match(library, /selection\.kind !== "external"/);
  assert.match(library, /rewriteLocalCompactions\(rewritten\.input, options\.compactionSecret\)/);
  assert.match(tests, /restores router-sealed summaries for native GPT requests/);
  assert.match(tests, /keeps ChatGPT-encrypted compactions untouched for native GPT requests/);
  assert.match(tests, /does not require a compaction secret for native requests without local compactions/);
});

test("Claude Hybrid uses only the 4.6 slots for DeepSeek", async () => {
  const config = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
  const aliases = config.models.external.flatMap((entry) => entry.aliases ?? []).sort();
  assert.deepEqual(aliases, ["claude-opus-4-6", "claude-sonnet-4-6"]);
  const patch = await readFile(resolve(claudeRoot, "src/app-patch.mjs"), "utf8");
  assert.match(patch, /\["Sonnet 4\.6","DeepSeek V4 Flash"\]/);
  assert.match(patch, /\["Opus 4\.6","DeepSeek V4 Pro \(1M\)"\]/);
  assert.doesNotMatch(patch, /\["Fable 5","DeepSeek/);
  assert.doesNotMatch(patch, /\["Opus 4\.8","DeepSeek/);
});

test("external-agent contract protects secrets, official apps, and billing", async () => {
  const handoff = await readFile(resolve(projectRoot, "AGENT_HANDOFF.md"), "utf8");
  const smoke = await readFile(resolve(projectRoot, "scripts/smoke.mjs"), "utf8");
  assert.match(handoff, /APIキーを推測・抽出・コピーしない/);
  assert.match(handoff, /純正実体は `~\/Applications\/Claude Official\.app`/);
  assert.match(handoff, /Do not use in-app updater on Hybrid/);
  assert.match(handoff, /replace Official source.*update-claude-hybrid --apply.*prefer-claude-hybrid/s);
  assert.match(handoff, /Fable 5 と Opus 4\.8/);
  assert.match(smoke, /--allow-billing/);
});

test("installer exposes safe updater and optional DeepSeek delegation without replacing the picker", async () => {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const updaterSkill = await readFile(resolve(projectRoot, "skills/claude-hybrid-update/SKILL.md"), "utf8");
  const delegationSkill = await readFile(resolve(projectRoot, "skills/deepseek-v4-delegation/SKILL.md"), "utf8");
  assert.equal(packageJson.scripts["update:claude:check"], "node scripts/update-claude.mjs --check");
  assert.match(updaterSkill, /Daily app: `\/Applications\/Claude\.app`.*Hybrid/);
  assert.match(updaterSkill, /Pristine source: `~\/Applications\/Claude Official\.app`/);
  assert.match(updaterSkill, /Do not use the in-app updater on Hybrid/);
  assert.match(updaterSkill, /prefer-claude-hybrid/);
  assert.match(updaterSkill, /Never fuzzy-patch/);
  assert.match(delegationSkill, /agent_type="deepseek-v4"/);
  assert.match(delegationSkill, /does not make DeepSeek the global default/);
});

test("installer defaults to the promoted Hybrid layout and verifies both roles", async () => {
  const config = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
  const verifier = await readFile(resolve(claudeRoot, "scripts/verify.mjs"), "utf8");
  const installer = await readFile(resolve(claudeRoot, "scripts/install.mjs"), "utf8");
  assert.equal(config.app.source, "<home>/Applications/Claude Official.app");
  assert.equal(config.app.target, "/Applications/Claude.app");
  assert.match(verifier, /sourceAppleSignature/);
  assert.match(verifier, /displayName/);
  assert.match(verifier, /autoUpdaterDisabled/);
  assert.match(installer, /preferClaudeHybrid/);
});
