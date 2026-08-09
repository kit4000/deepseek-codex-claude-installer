import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildClaudeDesktopGatewayConfig,
  newClaudeDesktopConfigLibrary,
  renderClaudeDesktopCredentialHelper,
  validateClaudeDesktopTemplate,
} from "../src/claude-desktop-config.mjs";

const templatePath = fileURLToPath(
  new URL("../config/claude-desktop-gateway.template.json", import.meta.url),
);
const template = JSON.parse(await readFile(templatePath, "utf8"));

test("builds a keyless gateway config for Claude Desktop", () => {
  const gateway = buildClaudeDesktopGatewayConfig(
    template,
    "/Users/example/.local/bin/claude-desktop-credential-helper",
  );
  assert.equal(gateway.inferenceProvider, "gateway");
  assert.equal(gateway.inferenceCredentialKind, "helper-script");
  assert.equal(gateway.inferenceCredentialHelper, "/Users/example/.local/bin/claude-desktop-credential-helper");
  assert.equal(gateway.inferenceGatewayBaseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(gateway.inferenceGatewayAuthScheme, "bearer");
  assert.equal(gateway.modelDiscoveryEnabled, false);
  assert.equal(gateway.disableDeploymentModeChooser, true);
  assert.equal(gateway.chatTabEnabled, true);
  assert.equal(gateway.inferenceGatewayApiKey, undefined);
  assert.equal(gateway.inferenceModels.length, 2);
  assert.deepEqual(
    gateway.inferenceModels.map((model) => model.name),
    ["claude-opus-4-5", "claude-haiku-4-5"],
  );
  assert.doesNotMatch(JSON.stringify(gateway), /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/);
});

test("rejects templates that redirect the credential away from DeepSeek", () => {
  assert.throws(
    () => buildClaudeDesktopGatewayConfig(
      { ...template, inferenceGatewayBaseUrl: "https://example.invalid/anthropic" },
      "/Users/example/.local/bin/claude-desktop-credential-helper",
    ),
    /non-official endpoint/,
  );
  assert.throws(
    () => validateClaudeDesktopTemplate({ ...template, inferenceModels: [] }),
    /At least one/,
  );
});

test("renders a Keychain-backed credential helper without embedding the token", () => {
  const helper = renderClaudeDesktopCredentialHelper({
    service: "com.local.codex-native-model-router.deepseek",
    account: "api-key",
  });
  assert.match(helper, /^#!\/bin\/sh/);
  assert.match(helper, /Managed by deepseek-handoff/);
  assert.match(
    helper,
    /security find-generic-password -s 'com\.local\.codex-native-model-router\.deepseek' -a 'api-key' -w/,
  );
  assert.doesNotMatch(helper, /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/);
});

test("records an appliedId that names the saved configuration file", () => {
  const gateway = buildClaudeDesktopGatewayConfig(
    template,
    "/Users/example/.local/bin/claude-desktop-credential-helper",
  );
  const { uuid, meta, config } = newClaudeDesktopConfigLibrary(gateway);
  assert.match(uuid, /^[a-f0-9-]{36}$/);
  assert.equal(meta.appliedId, uuid);
  assert.equal(config, gateway);
});
