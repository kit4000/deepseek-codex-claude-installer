import { isAbsolute, normalize, sep } from "node:path";

export const CODEX_ROUTER_BASE_URL = "http://127.0.0.1:10100/v1";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_KEYCHAIN = Object.freeze({
  service: "com.local.codex-native-model-router.deepseek",
  account: "api-key",
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateRouterForHandoff(config) {
  requireCondition(config?.listen?.host === "127.0.0.1", "Router must listen on loopback only");
  requireCondition(config?.listen?.port === 10100, "Router port must remain 10100");
  requireCondition(config?.native?.baseUrl === "https://chatgpt.com/backend-api/codex", "Unexpected native Codex upstream");

  const route = config.routes?.find((entry) => entry.namespace === "deepseek");
  requireCondition(route, "DeepSeek route is missing");
  requireCondition(route.baseUrl === "https://api.deepseek.com", "DeepSeek route must use the official API origin");
  requireCondition(route.suppressReasoningContent === true, "Raw reasoning suppression must remain enabled");
  requireCondition(route.stabilizeMessagePhase === true, "Message phase stabilization must remain enabled");
  requireCondition(route.auth?.mode === "bearer_keychain", "DeepSeek credential must come from macOS Keychain");
  requireCondition(route.auth?.service === DEEPSEEK_KEYCHAIN.service, "Unexpected DeepSeek Keychain service");
  requireCondition(route.auth?.account === DEEPSEEK_KEYCHAIN.account, "Unexpected DeepSeek Keychain account");
  requireCondition(route.models?.some((entry) => entry.id === "deepseek-v4-flash"), "DeepSeek V4 Flash is missing");
  requireCondition(!config.configMigration?.removeSections, "Handoff config must not remove unrelated Codex sections");
  requireCondition(config.configMigration?.profile?.model === "deepseek/deepseek-v4-flash", "Unexpected DeepSeek Codex profile");
  return config;
}

function rootTomlValue(source, key) {
  const lines = source.split(/\r?\n/);
  const rootEnd = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = lines.slice(0, rootEnd === -1 ? lines.length : rootEnd);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of root) {
    const match = line.match(pattern);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      return match[1];
    }
  }
  return undefined;
}

function tableTomlValue(source, tableName, key) {
  const lines = source.split(/\r?\n/);
  let active = false;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      active = section[1] === tableName;
      continue;
    }
    if (!active) continue;
    const match = line.match(pattern);
    if (!match) continue;
    if (match[1] === "true") return true;
    if (match[1] === "false") return false;
    try {
      return JSON.parse(match[1]);
    } catch {
      return match[1];
    }
  }
  return undefined;
}

export function inspectCodexConfig(source, { catalogPath, routerBaseUrl = CODEX_ROUTER_BASE_URL }) {
  return [
    {
      name: "Codex provider identity",
      ok: rootTomlValue(source, "model_provider") === "openai",
      expected: "openai",
    },
    {
      name: "Codex model catalog",
      ok: rootTomlValue(source, "model_catalog_json") === catalogPath,
      expected: catalogPath,
    },
    {
      name: "Codex loopback router",
      ok: rootTomlValue(source, "openai_base_url") === routerBaseUrl,
      expected: routerBaseUrl,
    },
    {
      name: "Codex request compression",
      ok: tableTomlValue(source, "features", "enable_request_compression") === false,
      expected: false,
    },
  ];
}

export function inspectRouterHealth(health, expectedRoutes = ["deepseek"]) {
  return health?.ok === true
    && health.provider === "openai"
    && expectedRoutes.every((route) => health.routes?.includes(route));
}

const MODEL_ENVIRONMENT_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

function inspectClaudeEnvironment(environment, source) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return [];
  const findings = [];
  const deepSeekBase = typeof environment.ANTHROPIC_BASE_URL === "string"
    && environment.ANTHROPIC_BASE_URL.toLowerCase().includes("deepseek");
  if (deepSeekBase) {
    findings.push(`${source}:ANTHROPIC_BASE_URL`);
    if (environment.ANTHROPIC_AUTH_TOKEN) findings.push(`${source}:ANTHROPIC_AUTH_TOKEN`);
  }
  for (const key of MODEL_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === "string" && environment[key].toLowerCase().includes("deepseek")) {
      findings.push(`${source}:${key}`);
    }
  }
  return findings;
}

export function findGlobalClaudeDeepSeekSettings(settings, environment = {}) {
  return [...new Set([
    ...inspectClaudeEnvironment(settings?.env, "~/.claude/settings.json"),
    ...inspectClaudeEnvironment(environment, "process environment"),
  ])].sort();
}

export function findShellDeepSeekExports(source, sourceName) {
  const findings = [];
  const relevant = new Set(["ANTHROPIC_BASE_URL", ...MODEL_ENVIRONMENT_KEYS]);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!match || !relevant.has(match[1])) continue;
    if (match[2].toLowerCase().includes("deepseek")) findings.push(`${sourceName}:${match[1]}`);
  }
  return [...new Set(findings)].sort();
}

export function validateClaudeDesktopTemplate(config) {
  requireCondition(config?.inferenceProvider === "gateway", "Claude Desktop provider must be gateway");
  requireCondition(config?.inferenceCredentialKind === "static", "Claude Desktop credential kind must be static");
  requireCondition(config?.inferenceGatewayBaseUrl === DEEPSEEK_ANTHROPIC_BASE_URL, "Unexpected Claude Desktop gateway URL");
  requireCondition(config?.inferenceGatewayAuthScheme === "bearer", "Claude Desktop must use Bearer authentication");
  requireCondition(config?.inferenceGatewayApiKey === "<ENTER_PER_DEVICE_IN_CLAUDE_DESKTOP>", "Desktop template must not contain a real API key");
  requireCondition(config?.modelDiscoveryEnabled === false, "Claude Desktop model discovery must be disabled for opaque model ids");
  const names = config?.inferenceModels?.map((entry) => entry.name) ?? [];
  requireCondition(
    names.includes("claude-opus-4-5") || names.includes("deepseek-v4-pro[1m]"),
    "Claude Desktop Pro model is missing",
  );
  requireCondition(
    names.includes("claude-haiku-4-5") || names.includes("deepseek-v4-flash"),
    "Claude Desktop Flash model is missing",
  );
  return config;
}

const FORBIDDEN_MANIFEST_FRAGMENTS = [
  ".git",
  ".DS_Store",
  ".bak",
  ".tar.gz",
  "auth.json",
  "sessions",
  "rollout",
  "repair-backup",
  "before-json-diagnostic",
];

export function validateHandoffManifest(files) {
  requireCondition(Array.isArray(files) && files.length > 0, "Handoff manifest must be a non-empty array");
  requireCondition(new Set(files).size === files.length, "Handoff manifest contains duplicate paths");
  for (const file of files) {
    requireCondition(typeof file === "string" && file.length > 0, "Handoff manifest contains an invalid path");
    requireCondition(!isAbsolute(file), `Absolute path is forbidden in handoff manifest: ${file}`);
    const normalized = normalize(file);
    requireCondition(normalized === file && !normalized.startsWith(`..${sep}`) && normalized !== "..", `Unsafe handoff path: ${file}`);
    requireCondition(
      !FORBIDDEN_MANIFEST_FRAGMENTS.some((fragment) => file.includes(fragment)),
      `Sensitive or machine-specific handoff path is forbidden: ${file}`,
    );
  }
  requireCondition(files.includes("DEEPSEEK_HANDOFF.md"), "Handoff guide is missing from manifest");
  requireCondition(files.includes("router-config.json"), "Router config is missing from manifest");
  requireCondition(files.includes("config/claude-deepseek.json"), "Claude config is missing from manifest");
  return files;
}
