import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { claudeRoot, codexRoot, projectRoot } from "../scripts/lib.mjs";
import { renderClaudeHybridAgents } from "../claude-hybrid/src/claude-agents.mjs";

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

test("DeepSeek router sanitizes compact and Codex custom tool pairs", async () => {
  const library = await readFile(resolve(codexRoot, "src/lib.mjs"), "utf8");
  const router = await readFile(resolve(codexRoot, "src/router.mjs"), "utf8");
  const tests = await readFile(resolve(codexRoot, "test/router.test.mjs"), "utf8");
  const handoff = await readFile(resolve(projectRoot, "AGENT_HANDOFF.md"), "utf8");
  assert.match(library, /function repairToolCallPairs/);
  assert.match(library, /function repairNativeInputItem/);
  assert.match(library, /isOpaqueEncryptedPayload/);
  assert.match(library, /custom_tool_call/);
  assert.match(library, /isCompactEndpoint/);
  assert.match(library, /externalUpstreamPath/);
  assert.match(router, /compactEndpoint/);
  assert.match(router, /externalUpstreamPath\(pathname\)/);
  assert.match(tests, /maps Codex custom_tool_call pairs onto DeepSeek function_call pairs/);
  assert.match(tests, /strips OpenAI encrypted function outputs and agent_message before DeepSeek/);
  assert.match(tests, /maps \/responses\/compact onto a DeepSeek text-only summary turn/);
  assert.match(tests, /repairs MultiAgent V2 plaintext stored as encrypted_content for native GPT/);
  assert.match(handoff, /No tool call found for tool output with call_id/);
  assert.match(handoff, /Encrypted function output content could not be decrypted or decoded/);
  assert.match(handoff, /MultiAgent V2/);
});

test("Claude Hybrid uses 4.6 DeepSeek slots and keeps newer Claude native", async () => {
  const config = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
  const aliases = config.models.external.flatMap((entry) => entry.aliases ?? []).sort();
  assert.deepEqual(aliases, [
    "claude-haiku-4-5-external-flash",
    "claude-opus-4-5-external-pro",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ]);
  const byTarget = Object.fromEntries(config.models.external.map((entry) => [entry.target, entry]));
  assert.equal(byTarget["deepseek-v4-pro[1m]"].provider, "deepseek");
  assert.equal(byTarget["deepseek-v4-flash"].provider, "deepseek");
  assert.equal(byTarget["gpt-5.6-sol"], undefined);
  assert.equal(byTarget["gpt-5.6-luna"], undefined);
  assert.ok(!config.models.external.some((entry) => entry.provider === "openai"));
  assert.equal(config.openai, undefined);
  const patch = await readFile(resolve(claudeRoot, "src/app-patch.mjs"), "utf8");
  assert.match(patch, /\["Sonnet 4\.6", "DeepSeek V4 Flash"\]/);
  assert.match(patch, /\["Opus 4\.6", "DeepSeek V4 Pro \(1M\)"\]/);
  assert.doesNotMatch(patch, /\["Opus 4\.8"/);
  assert.doesNotMatch(patch, /\["Opus 4\.7"/);
  assert.doesNotMatch(patch, /GPT-5\.6 Sol/);
  assert.doesNotMatch(patch, /GPT-5\.6 Luna/);
  assert.match(patch, /ANTHROPIC_UNIX_SOCKET/);
  assert.match(patch, /ANTHROPIC_DEFAULT_HAIKU_MODEL:"deepseek-v4-flash"/);
  assert.doesNotMatch(patch, /ANTHROPIC_CUSTOM_MODEL_OPTION/);
  assert.doesNotMatch(patch, /ANTHROPIC_DEFAULT_OPUS_MODEL/);
  assert.doesNotMatch(patch, /ANTHROPIC_DEFAULT_SONNET_MODEL/);
  assert.doesNotMatch(patch, /\["Fable 5"/);
  assert.doesNotMatch(patch, /\["Opus 4\.5"/);
  assert.doesNotMatch(patch, /\["Sonnet 4\.5"/);
  assert.doesNotMatch(patch, /\["Opus 5"/);
  assert.doesNotMatch(patch, /\["Sonnet 5"/);
  assert.doesNotMatch(patch, /\["Haiku 4\.5"/);
  const agents = renderClaudeHybridAgents(config);
  assert.deepEqual(agents.map((entry) => entry.name).sort(), [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
});

test("external-agent contract protects secrets, official apps, and billing", async () => {
  const handoff = await readFile(resolve(projectRoot, "AGENT_HANDOFF.md"), "utf8");
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  const smoke = await readFile(resolve(projectRoot, "scripts/smoke.mjs"), "utf8");
  const hybridSmoke = await readFile(resolve(claudeRoot, "scripts/smoke.mjs"), "utf8");
  assert.match(handoff, /APIキーを推測・抽出・コピーしない/);
  assert.match(handoff, /純正実体は `~\/Applications\/Claude Official\.app`/);
  assert.match(handoff, /Do not use in-app updater on Hybrid/);
  assert.match(handoff, /RELEASES\.json/);
  assert.match(handoff, /replace Official source.*update-claude-hybrid --check.*update-claude-hybrid --apply.*prefer-claude-hybrid/s);
  assert.match(handoff, /1\.28929\.0/);
  assert.match(handoff, /2026-08-18\.3/);
  assert.match(handoff, /ANTHROPIC_UNIX_SOCKET/);
  assert.match(handoff, /Fable 5 と Opus 4\.8、Opus 5/);
  assert.match(handoff, /GitHub URL だけを渡されたエージェントは、この文書を全文読んでから導入します/);
  assert.match(handoff, /git clone https:\/\/github\.com\/kit4000\/deepseek-codex-claude-installer\.git/);
  assert.match(readme, /https:\/\/github\.com\/kit4000\/deepseek-codex-claude-installer/);
  assert.match(readme, /外部エージェントには \*\*この URL だけ\*\* を渡してください/);
  assert.match(smoke, /--allow-billing/);
  assert.match(hybridSmoke, /--allow-billing/);
});

test("installer records the Claude official-to-hybrid update pattern", async () => {
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  const changeSpec = await readFile(resolve(projectRoot, "CHANGE_SPEC-claude-app-layout-and-updates.md"), "utf8");
  const skill = await readFile(resolve(projectRoot, "skills/claude-hybrid-update/SKILL.md"), "utf8");
  const hybridReadme = await readFile(resolve(claudeRoot, "README.md"), "utf8");
  const config = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
  assert.equal(config.app.patchVersion, "2026-08-18.3");
  assert.equal(config.app.patchFile, "/.vite/build/index.chunk-KnwvxAXh.js");
  assert.equal(config.app.modelLabelPatchFile, "/.vite/build/index.chunk-CHjD_WiU.js");
  assert.match(readme, /downloads\.claude\.ai\/releases\/darwin\/universal\/RELEASES\.json/);
  assert.match(changeSpec, /実証済みアップデートパターン/);
  assert.match(changeSpec, /1\.28929\.0/);
  assert.match(skill, /Proven update pattern/);
  assert.match(skill, /RELEASES\.json/);
  assert.match(hybridReadme, /RELEASES\.json/);
  assert.match(hybridReadme, /1\.28929\.0/);
  assert.match(hybridReadme, /--allow-billing/);
  assert.doesNotMatch(hybridReadme, /npm run smoke\s+# DeepSeek/);
});

test("installer exposes safe updater and optional DeepSeek delegation without replacing the picker", async () => {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const updaterSkill = await readFile(resolve(projectRoot, "skills/claude-hybrid-update/SKILL.md"), "utf8");
  const delegationSkill = await readFile(resolve(projectRoot, "skills/deepseek-v4-delegation/SKILL.md"), "utf8");
  const installer = await readFile(resolve(projectRoot, "scripts/install.mjs"), "utf8");
  const verifier = await readFile(resolve(projectRoot, "scripts/verify.mjs"), "utf8");
  assert.equal(packageJson.scripts["update:claude:check"], "node scripts/update-claude.mjs --check");
  assert.equal(packageJson.scripts["cursor-cli"], "node scripts/cursor-cli-delegate.mjs");
  assert.match(installer, /scripts\/install-extensions\.mjs/);
  assert.match(installer, /\/gpt-5-6-sol/);
  assert.match(installer, /codex-cli-delegate --check-auth/);
  assert.match(verifier, /scripts\/verify-extensions\.mjs/);
  assert.match(verifier, /ChatGPT Codex CLI wrapper/);
  assert.match(updaterSkill, /Daily app: `\/Applications\/Claude\.app`.*Hybrid/);
  assert.match(updaterSkill, /Pristine source: `~\/Applications\/Claude Official\.app`/);
  assert.match(updaterSkill, /Do not use the in-app updater on Hybrid/);
  assert.match(updaterSkill, /prefer-claude-hybrid/);
  assert.match(updaterSkill, /Never fuzzy-patch/);
  assert.match(updaterSkill, /\/gpt-5-6-sol/);
  assert.match(delegationSkill, /agent_type="deepseek-v4"/);
  assert.match(delegationSkill, /does not make DeepSeek the global default/);
});

test("Cursor CLI wrappers bill Grok 4.6 and Composer 2.5 to the Cursor subscription", async () => {
  const skill = await readFile(resolve(projectRoot, "skills/cursor-cli-delegation/SKILL.md"), "utf8");
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  const handoff = await readFile(resolve(projectRoot, "AGENT_HANDOFF.md"), "utf8");
  const files = JSON.parse(await readFile(resolve(projectRoot, "config/integrated-files.json"), "utf8"));
  assert.match(skill, /cursor-grok-4-6/);
  assert.match(skill, /cursor-composer-2-5/);
  assert.match(skill, /agent login/);
  assert.match(skill, /Do not set `CURSOR_API_KEY`/);
  assert.match(skill, /Do not hijack additional Claude\.app picker rows/);
  assert.match(readme, /cursor-cli-delegate --check-auth/);
  assert.match(handoff, /cursor-grok-4\.6-high-fast/);
  assert.match(handoff, /composer-2\.5-fast/);
  assert.ok(files.includes("src/cursor-cli.mjs"));
  assert.ok(files.includes("scripts/cursor-cli-delegate.mjs"));
  assert.ok(files.includes("skills/cursor-cli-delegation/SKILL.md"));
});

test("Codex CLI wrappers bill GPT-5.6 Sol and Luna to the ChatGPT subscription", async () => {
  const skill = await readFile(resolve(projectRoot, "skills/chatgpt-codex-delegation/SKILL.md"), "utf8");
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  const handoff = await readFile(resolve(projectRoot, "AGENT_HANDOFF.md"), "utf8");
  const files = JSON.parse(await readFile(resolve(projectRoot, "config/integrated-files.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["codex-cli"], "node scripts/codex-cli-delegate.mjs");
  assert.equal(packageJson.scripts["store-openai-key"], undefined);
  assert.ok(!files.includes("scripts/store-openai-key.mjs"));
  assert.match(skill, /\/gpt-5-6-sol/);
  assert.match(skill, /\/gpt-5-6-luna/);
  assert.match(skill, /codex login/);
  assert.match(skill, /Do not set `OPENAI_API_KEY`/);
  assert.match(skill, /Do not hijack additional Claude\.app picker rows/);
  assert.match(readme, /codex-cli-delegate --check-auth/);
  assert.match(readme, /\/gpt-5-6-sol/);
  assert.match(readme, /\/gpt-5-6-luna/);
  assert.match(handoff, /gpt-5\.6-sol/);
  assert.match(handoff, /gpt-5\.6-luna/);
  assert.match(handoff, /\/gpt-5-6-sol/);
  assert.match(handoff, /chatgpt-codex-delegation/);
  assert.ok(files.includes("src/codex-cli.mjs"));
  assert.ok(files.includes("scripts/codex-cli-delegate.mjs"));
  assert.ok(files.includes("skills/chatgpt-codex-delegation/SKILL.md"));
  const changeSpec = await readFile(resolve(projectRoot, "CHANGE_SPEC-claude-app-layout-and-updates.md"), "utf8");
  assert.match(changeSpec, /### 3\.7 ChatGPT \/ Cursor サブスクはピッカー枠ではなく CLI 委譲/);
  assert.match(changeSpec, /### 3\.8 配布の正本は GitHub/);
  assert.match(changeSpec, /\/gpt-5-6-sol/);
  const manifest = JSON.parse(await readFile(resolve(projectRoot, "INSTALLER_MANIFEST.json"), "utf8"));
  assert.match(manifest.purpose, /ChatGPT Codex CLI/);
  assert.ok(manifest.files["src/codex-cli.mjs"]);
  assert.ok(manifest.files["scripts/codex-cli-delegate.mjs"]);
  assert.ok(manifest.files["skills/chatgpt-codex-delegation/SKILL.md"]);
  assert.ok(manifest.files["test/codex-cli.test.mjs"]);
  assert.equal(manifest.files["scripts/store-openai-key.mjs"], undefined);
  assert.equal(manifest.files["claude-hybrid/scripts/store-openai-key.mjs"], undefined);
  assert.match(manifest.protected.join("\n"), /Opus 4\.8/);
});

test("installer defaults to the promoted Hybrid layout and verifies both roles", async () => {
  const config = JSON.parse(await readFile(resolve(claudeRoot, "config/claude-hybrid.json"), "utf8"));
  const verifier = await readFile(resolve(claudeRoot, "scripts/verify.mjs"), "utf8");
  const installer = await readFile(resolve(claudeRoot, "scripts/install.mjs"), "utf8");
  assert.equal(config.app.source, "<home>/Applications/Claude Official.app");
  assert.equal(config.app.target, "/Applications/Claude.app");
  assert.match(config.router.socketPath, /Claude Hybrid\/router\.sock/);
  assert.match(verifier, /sourceAppleSignature/);
  assert.match(verifier, /displayName/);
  assert.match(verifier, /autoUpdaterDisabled/);
  assert.match(installer, /preferClaudeHybrid/);
});
