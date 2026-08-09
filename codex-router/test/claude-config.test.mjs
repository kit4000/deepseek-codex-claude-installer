import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildClaudeEnvironment,
  parseClaudeLauncherArgs,
  publicClaudeConfiguration,
  renderClaudeWrapper,
  validateClaudeConfig,
} from "../src/claude-config.mjs";

const configPath = fileURLToPath(new URL("../config/claude-deepseek.json", import.meta.url));
const config = validateClaudeConfig(JSON.parse(await readFile(configPath, "utf8")));

test("validates the official DeepSeek Anthropic endpoint and rejects credential redirection", () => {
  assert.equal(config.anthropicBaseUrl, "https://api.deepseek.com/anthropic");
  assert.throws(() => validateClaudeConfig({
    ...config,
    anthropicBaseUrl: "https://example.invalid/anthropic",
  }), /non-official endpoint/);
});

test("parses DeepSeek-only launcher options without consuming Claude options", () => {
  assert.deepEqual(parseClaudeLauncherArgs([
    "--deepseek-model", "flash", "--resume", "session-id",
  ], config), {
    selectedModel: "flash",
    printConfig: false,
    claudeArgs: ["--resume", "session-id"],
  });
  assert.throws(
    () => parseClaudeLauncherArgs(["--deepseek-model=unknown"], config),
    /unknown model/,
  );
});

test("scopes DeepSeek routing to the child process and keeps the session directory", () => {
  const environment = buildClaudeEnvironment({
    HOME: "/Users/example",
    CLAUDE_CONFIG_DIR: "/tmp/existing-claude-sessions",
    ANTHROPIC_API_KEY: "must-be-removed",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.invalid",
  }, config, "deepseek-secret", "flash");

  assert.equal(environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "deepseek-secret");
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(environment.ANTHROPIC_BEDROCK_BASE_URL, undefined);
  assert.equal(environment.ANTHROPIC_MODEL, "deepseek-v4-flash");
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash");
  assert.equal(environment.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/tmp/existing-claude-sessions");
});

test("prints only public launcher state and never includes the credential", () => {
  const publicConfig = publicClaudeConfiguration(config, "pro", true, {});
  assert.equal(publicConfig.selectedModel, "deepseek-v4-pro[1m]");
  assert.equal(publicConfig.credential.available, true);
  assert.doesNotMatch(JSON.stringify(publicConfig), /deepseek-secret/);
  assert.equal(publicConfig.sessionStore, "~/.claude (unchanged)");
});

test("renders an executable wrapper with shell-safe absolute paths", () => {
  const wrapper = renderClaudeWrapper("/opt/Node's/bin/node", "/Users/Test App/claude-deepseek.mjs");
  assert.match(wrapper, /^#!\/bin\/sh/);
  assert.match(wrapper, /Managed by deepseek-handoff/);
  assert.match(wrapper, /'\/opt\/Node'\\''s\/bin\/node'/);
  assert.match(wrapper, /'\/Users\/Test App\/claude-deepseek\.mjs'/);
  assert.match(wrapper, /"\$@"/);
});
