import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findGlobalClaudeDeepSeekSettings,
  findShellDeepSeekExports,
  inspectCodexConfig,
  inspectRouterHealth,
  validateClaudeDesktopTemplate,
  validateHandoffManifest,
  validateRouterForHandoff,
} from "../src/handoff.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("validates the portable router and display stability settings", async () => {
  const config = JSON.parse(await readFile(resolve(projectRoot, "router-config.json"), "utf8"));
  assert.equal(validateRouterForHandoff(config), config);
  assert.throws(
    () => validateRouterForHandoff({
      ...config,
      routes: config.routes.map((route) => ({ ...route, suppressReasoningContent: false })),
    }),
    /reasoning suppression/,
  );
});

test("inspects only the managed Codex root settings", () => {
  const catalogPath = "/Users/test/.codex/model-catalogs/native-plus-external.json";
  const source = `model_provider = "openai"
model_catalog_json = "${catalogPath}"
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
enable_request_compression = false

[profiles.unrelated]
model_provider = "another-provider"
`;
  assert.ok(inspectCodexConfig(source, { catalogPath }).every((entry) => entry.ok));
});

test("requires the exact router health identity", () => {
  assert.equal(inspectRouterHealth({ ok: true, provider: "openai", routes: ["deepseek"] }), true);
  assert.equal(inspectRouterHealth({ ok: true, provider: "unexpected", routes: ["deepseek"] }), false);
  assert.equal(inspectRouterHealth({ ok: true, provider: "openai", routes: [] }), false);
});

test("detects global DeepSeek Claude settings without exposing values", () => {
  const findings = findGlobalClaudeDeepSeekSettings({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "super-secret-value",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
    },
  });
  assert.deepEqual(findings, [
    "~/.claude/settings.json:ANTHROPIC_AUTH_TOKEN",
    "~/.claude/settings.json:ANTHROPIC_BASE_URL",
    "~/.claude/settings.json:ANTHROPIC_MODEL",
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /super-secret-value/);
  assert.deepEqual(findGlobalClaudeDeepSeekSettings({ env: { ANTHROPIC_MODEL: "sonnet" } }), []);
});

test("detects active shell exports and ignores comments", () => {
  assert.deepEqual(findShellDeepSeekExports(`
# export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export SOMETHING_ELSE=deepseek
`, "~/.zshrc"), ["~/.zshrc:ANTHROPIC_MODEL"]);
});

test("validates the secret-free Claude Desktop template", async () => {
  const config = JSON.parse(await readFile(
    resolve(projectRoot, "config/claude-desktop-gateway.template.json"),
    "utf8",
  ));
  assert.equal(validateClaudeDesktopTemplate(config), config);
  assert.throws(
    () => validateClaudeDesktopTemplate({ ...config, inferenceGatewayApiKey: "a-real-key" }),
    /must not contain a real API key/,
  );
});

test("handoff manifest excludes machine state, backups, and credentials", async () => {
  const files = JSON.parse(await readFile(resolve(projectRoot, "config/handoff-files.json"), "utf8"));
  assert.equal(validateHandoffManifest(files), files);
  assert.throws(() => validateHandoffManifest([...files, "auth.json"]), /forbidden/);
  assert.throws(() => validateHandoffManifest([...files, "../secret"]), /Unsafe/);
});

test("installers do not address Codex or Claude session stores", async () => {
  const installers = await Promise.all([
    "scripts/install.mjs",
    "scripts/install-claude.mjs",
    "scripts/install-handoff.mjs",
  ].map((file) => readFile(resolve(projectRoot, file), "utf8")));
  const source = installers.join("\n");
  assert.doesNotMatch(source, /state_5\.sqlite|\.codex\/sessions|\.claude\.json|\.claude\/projects/);
});
