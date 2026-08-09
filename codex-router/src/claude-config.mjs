const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

const CLEARED_PROVIDER_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL"
];

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function model(config, key) {
  const entry = config.models?.[key];
  if (!entry) throw new Error(`Claude model alias points to an unknown model: ${key}`);
  return entry;
}

export function validateClaudeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude DeepSeek configuration must be a JSON object");
  }
  if (config.version !== 1) throw new Error(`Unsupported Claude DeepSeek config version: ${config.version}`);
  if (config.anthropicBaseUrl !== OFFICIAL_ANTHROPIC_BASE_URL) {
    throw new Error(`Refusing to send the DeepSeek credential to a non-official endpoint: ${config.anthropicBaseUrl}`);
  }
  requiredString(config.keychain?.service, "keychain.service");
  requiredString(config.keychain?.account, "keychain.account");
  const modelEntries = Object.entries(config.models ?? {});
  if (modelEntries.length === 0) throw new Error("At least one Claude DeepSeek model is required");
  for (const [key, entry] of modelEntries) {
    const id = requiredString(entry?.id, `models.${key}.id`);
    requiredString(entry?.displayName, `models.${key}.displayName`);
    if (!id.startsWith("deepseek-")) throw new Error(`Unexpected DeepSeek model id: ${id}`);
  }
  model(config, config.defaultModel);
  model(config, config.aliases?.opus);
  model(config, config.aliases?.sonnet);
  model(config, config.aliases?.haiku);
  model(config, config.subagentModel);
  if (!new Set(["low", "medium", "high", "max"]).has(config.effort)) {
    throw new Error(`Unsupported Claude effort level: ${config.effort}`);
  }
  return config;
}

export function parseClaudeLauncherArgs(args, config) {
  let selectedModel = config.defaultModel;
  let printConfig = false;
  const claudeArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--deepseek-model") {
      selectedModel = args[index + 1];
      index += 1;
      if (!selectedModel) throw new Error("--deepseek-model requires a model key");
      continue;
    }
    if (argument.startsWith("--deepseek-model=")) {
      selectedModel = argument.slice("--deepseek-model=".length);
      continue;
    }
    if (argument === "--deepseek-print-config") {
      printConfig = true;
      continue;
    }
    claudeArgs.push(argument);
  }

  model(config, selectedModel);
  return { selectedModel, printConfig, claudeArgs };
}

export function buildClaudeEnvironment(baseEnvironment, config, token, selectedModel) {
  validateClaudeConfig(config);
  requiredString(token, "DeepSeek credential");
  const environment = { ...baseEnvironment };
  for (const name of CLEARED_PROVIDER_VARIABLES) delete environment[name];

  const selected = model(config, selectedModel);
  const opus = model(config, config.aliases.opus);
  const sonnet = model(config, config.aliases.sonnet);
  const haiku = model(config, config.aliases.haiku);
  const subagent = model(config, config.subagentModel);

  Object.assign(environment, {
    ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: selected.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opus.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: opus.displayName,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "DeepSeek official Anthropic-compatible API",
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: sonnet.displayName,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "DeepSeek official Anthropic-compatible API",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: haiku.displayName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: "DeepSeek official Anthropic-compatible API",
    ANTHROPIC_CUSTOM_MODEL_OPTION: haiku.id,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: haiku.displayName,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "DeepSeek official fast model",
    CLAUDE_CODE_SUBAGENT_MODEL: subagent.id,
    CLAUDE_CODE_EFFORT_LEVEL: config.effort,
  });
  return environment;
}

export function publicClaudeConfiguration(config, selectedModel, credentialAvailable, baseEnvironment = {}) {
  validateClaudeConfig(config);
  const selected = model(config, selectedModel);
  return {
    provider: config.provider,
    baseUrl: config.anthropicBaseUrl,
    selectedModel: selected.id,
    selectableModels: Object.fromEntries(
      Object.entries(config.models).map(([key, entry]) => [key, entry.id]),
    ),
    effort: config.effort,
    credential: {
      source: "macOS Keychain",
      service: config.keychain.service,
      account: config.keychain.account,
      available: credentialAvailable,
    },
    sessionStore: baseEnvironment.CLAUDE_CONFIG_DIR ?? "~/.claude (unchanged)",
  };
}

export function renderClaudeWrapper(nodePath, launcherPath) {
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Managed by deepseek-handoff. Rerun npm run install:claude after moving the bundle.",
    `exec ${quote(nodePath)} ${quote(launcherPath)} "$@"`,
    "",
  ].join("\n");
}
