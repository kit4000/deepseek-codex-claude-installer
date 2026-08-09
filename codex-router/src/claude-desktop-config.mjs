import { randomUUID } from "node:crypto";

export const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const CREDENTIAL_HELPER_MARKER = "# Managed by deepseek-handoff.";

const ANTHROPIC_MODEL_ALIASES = new Map([
  ["deepseek-v4-pro[1m]", "claude-opus-4-5"],
  ["deepseek-v4-flash", "claude-haiku-4-5"],
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredModel(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`inferenceModels[${index}] must be an object`);
  }
  const name = requiredString(entry.name, `inferenceModels[${index}].name`);
  if (!name.startsWith("deepseek-") && !name.startsWith("claude-")) {
    throw new Error(`Unexpected DeepSeek model id: ${name}`);
  }
  return entry;
}

export function anthropicAliasForDeepSeekModel(name) {
  requiredString(name, "model name");
  if (name.startsWith("claude-")) return name;
  const alias = ANTHROPIC_MODEL_ALIASES.get(name);
  if (!alias) throw new Error(`No Claude Desktop alias for DeepSeek model id: ${name}`);
  return alias;
}

export function validateClaudeDesktopTemplate(template) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("Claude Desktop gateway template must be a JSON object");
  }
  if (template.inferenceProvider !== "gateway") {
    throw new Error("Claude Desktop template must use inferenceProvider gateway");
  }
  if (template.inferenceGatewayBaseUrl !== OFFICIAL_ANTHROPIC_BASE_URL) {
    throw new Error(
      `Refusing to send the DeepSeek credential to a non-official endpoint: ${template.inferenceGatewayBaseUrl}`,
    );
  }
  if (!Array.isArray(template.inferenceModels) || template.inferenceModels.length === 0) {
    throw new Error("At least one Claude Desktop model is required");
  }
  template.inferenceModels.forEach(requiredModel);
  return template;
}

export function buildClaudeDesktopGatewayConfig(template, helperPath) {
  validateClaudeDesktopTemplate(template);
  requiredString(helperPath, "credential helper path");
  return {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "helper-script",
    inferenceCredentialHelper: helperPath,
    inferenceCredentialHelperTtlSec: 3600,
    inferenceGatewayBaseUrl: template.inferenceGatewayBaseUrl,
    inferenceGatewayAuthScheme: template.inferenceGatewayAuthScheme,
    modelDiscoveryEnabled: template.modelDiscoveryEnabled,
    disableDeploymentModeChooser: true,
    chatTabEnabled: true,
    inferenceModels: template.inferenceModels.map((entry) => ({
      ...entry,
      name: anthropicAliasForDeepSeekModel(entry.name),
    })),
  };
}

export function renderClaudeDesktopCredentialHelper(keychain) {
  requiredString(keychain?.service, "keychain.service");
  requiredString(keychain?.account, "keychain.account");
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `${CREDENTIAL_HELPER_MARKER} Rerun npm run install:claude-desktop after moving the bundle.`,
    `exec security find-generic-password -s ${quote(keychain.service)} -a ${quote(keychain.account)} -w`,
    "",
  ].join("\n");
}

export function newClaudeDesktopConfigLibrary(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude Desktop gateway config must be a JSON object");
  }
  const uuid = randomUUID();
  return {
    uuid,
    meta: { appliedId: uuid },
    config,
  };
}
