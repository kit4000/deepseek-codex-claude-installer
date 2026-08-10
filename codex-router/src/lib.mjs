import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const LOCAL_COMPACTION_PREFIX = "codex-native-model-router:compaction:v1:";
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function selectRoute(model, config) {
  if (typeof model === "string") {
    for (const route of config.routes ?? []) {
      const prefix = `${route.namespace}/`;
      if (model.startsWith(prefix)) {
        return {
          kind: "external",
          route,
          upstreamModel: model.slice(prefix.length),
        };
      }
    }
  }

  if (typeof model === "string" && model.includes("/")) {
    return { kind: "unknown", upstreamModel: model };
  }

  return { kind: "native", route: config.native, upstreamModel: model };
}

export function upstreamUrl(baseUrl, incomingUrl) {
  const incoming = new URL(incomingUrl, "http://127.0.0.1");
  const relativePath = incoming.pathname.replace(/^\/v1(?=\/|$)/, "");
  const base = baseUrl.replace(/\/$/, "");
  return `${base}${relativePath || "/"}${incoming.search}`;
}

function compactionKey(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw Object.assign(new Error("A compaction secret is required"), { statusCode: 503 });
  }
  return createHash("sha256")
    .update("codex-native-model-router local compaction\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function sealLocalCompaction(summary, secret) {
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error("Cannot seal an empty compaction summary");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", compactionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(summary, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${LOCAL_COMPACTION_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function openLocalCompaction(payload, secret) {
  if (typeof payload !== "string" || !payload.startsWith(LOCAL_COMPACTION_PREFIX)) {
    throw Object.assign(new Error("Unsupported external compaction payload"), { statusCode: 422 });
  }
  try {
    const packed = Buffer.from(payload.slice(LOCAL_COMPACTION_PREFIX.length), "base64url");
    if (packed.length < 29) throw new Error("Compaction payload is truncated");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", compactionKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("Could not decrypt the external compaction payload"), {
      statusCode: 422,
    });
  }
}

const EXTERNAL_SUPPORTED_INPUT_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "reasoning",
  "web_search_call",
]);

export function isCompactEndpoint(pathname) {
  return typeof pathname === "string" && /\/responses\/compact\/?$/.test(pathname);
}

export function isRemoteCompactionV2Request(body, selection, options = {}) {
  if (selection.kind !== "external") return false;
  if (options.compactEndpoint) return true;
  return Array.isArray(body?.input)
    && body.input.some((item) => item?.type === "compaction_trigger");
}

export function hasLocalCompaction(input) {
  return Array.isArray(input)
    && input.some((item) => item?.type === "compaction"
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.startsWith(LOCAL_COMPACTION_PREFIX));
}

function rewriteLocalCompactions(input, compactionSecret) {
  if (!hasLocalCompaction(input)) return input;
  return input.flatMap((item) => {
    if (item?.type !== "compaction"
      || typeof item.encrypted_content !== "string"
      || !item.encrypted_content.startsWith(LOCAL_COMPACTION_PREFIX)) {
      return [item];
    }
    const summary = openLocalCompaction(item.encrypted_content, compactionSecret);
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: summary }],
    }];
  });
}

function extractTextParts(content) {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "input_text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    // OpenAI-only ciphertext cannot be decrypted by DeepSeek or this router.
    if (part.type === "encrypted_content") return [];
    if (typeof part.text === "string" && part.text.length > 0) {
      if (part.type === "output_text") return [{ type: "output_text", text: part.text }];
      return [{ type: "input_text", text: part.text }];
    }
    if (part.type === "input_image" || part.type === "input_file") return [];
    return [];
  });
}

function contentToUserMessage(content, role = "user") {
  const parts = extractTextParts(content)
    .map((part) => ({ type: "input_text", text: part.text }));
  if (parts.length === 0) return [];
  return [{ type: "message", role, content: parts }];
}

function sanitizeFunctionCallOutput(item) {
  let output;
  if (typeof item.output === "string") {
    output = item.output.trim();
  } else if (Array.isArray(item.output)) {
    output = extractTextParts(item.output).map((part) => part.text).join("\n").trim();
  } else if (item.output && typeof item.output === "object") {
    if (item.output.type === "encrypted_content") return [];
    if (typeof item.output.text === "string") output = item.output.text.trim();
  } else if (Array.isArray(item.content)) {
    output = extractTextParts(item.content).map((part) => part.text).join("\n").trim();
  }

  if (!output) return [];
  if (typeof item.call_id !== "string" || item.call_id.length === 0) return [];
  return [{
    type: "function_call_output",
    call_id: item.call_id,
    output,
  }];
}

function functionCallArguments(item) {
  if (typeof item.arguments === "string" && item.arguments.length > 0) {
    return item.arguments;
  }
  // Codex custom tools (apply_patch, exec, ...) use freeform `input`.
  if (typeof item.input === "string") {
    return JSON.stringify({ input: item.input });
  }
  if (item.input != null) {
    return JSON.stringify({ input: item.input });
  }
  if (item.action != null) {
    return JSON.stringify({ action: item.action });
  }
  return "{}";
}

function sanitizeFunctionCall(item) {
  if (typeof item.call_id !== "string" || item.call_id.length === 0) return [];
  const name = typeof item.name === "string" && item.name.length > 0
    ? item.name
    : (item.type === "local_shell_call" ? "local_shell" : "tool");
  return [{
    type: "function_call",
    call_id: item.call_id,
    name,
    arguments: functionCallArguments(item),
  }];
}

function repairToolCallPairs(input) {
  const callIds = new Set(
    input
      .filter((item) => item?.type === "function_call" && typeof item.call_id === "string")
      .map((item) => item.call_id),
  );
  const repaired = [];
  for (const item of input) {
    if (item?.type === "function_call_output" && typeof item.call_id === "string") {
      if (!callIds.has(item.call_id)) {
        // DeepSeek rejects orphan outputs. Restore a stub call so history can continue.
        repaired.push({
          type: "function_call",
          call_id: item.call_id,
          name: "tool",
          arguments: "{}",
        });
        callIds.add(item.call_id);
      }
    }
    repaired.push(item);
  }

  const outputIds = new Set(
    repaired
      .filter((item) => item?.type === "function_call_output" && typeof item.call_id === "string")
      .map((item) => item.call_id),
  );
  // Historical calls without outputs also 400; keep only trailing unanswered calls
  // (the in-flight turn Codex is about to satisfy).
  let lastNonCallIndex = repaired.length - 1;
  while (lastNonCallIndex >= 0 && repaired[lastNonCallIndex]?.type === "function_call") {
    lastNonCallIndex -= 1;
  }
  const trailingPending = new Set(
    repaired.slice(lastNonCallIndex + 1).map((item) => item.call_id),
  );
  return repaired.flatMap((item, index) => {
    if (item?.type !== "function_call") return [item];
    if (outputIds.has(item.call_id) || trailingPending.has(item.call_id)) return [item];
    return [
      item,
      {
        type: "function_call_output",
        call_id: item.call_id,
        output: "(tool output unavailable)",
      },
    ];
  });
}

function sanitizeExternalInputItem(item) {
  if (!item || typeof item !== "object") return [];

  if (item.type === "compaction_trigger") {
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }],
    }];
  }

  if (item.type === "compaction") {
    // Opaque ChatGPT/provider compactions cannot be forwarded to DeepSeek.
    // Router-sealed ones are restored before this helper runs.
    return [];
  }

  if (item.type === "agent_message") {
    // DeepSeek ignores agent_message items. Deliver plaintext as a normal user message.
    return contentToUserMessage(item.content, "user");
  }

  if (item.type === "message") {
    const content = extractTextParts(item.content)
      .map((part) => ({ type: "input_text", text: part.text }));
    if (content.length === 0) return [];
    return [{
      type: "message",
      role: item.role ?? "user",
      content,
    }];
  }

  if (item.type === "function_call"
    || item.type === "custom_tool_call"
    || item.type === "local_shell_call") {
    return sanitizeFunctionCall(item);
  }

  if (item.type === "function_call_output"
    || item.type === "custom_tool_call_output"
    || item.type === "local_shell_call_output") {
    return sanitizeFunctionCallOutput(item);
  }

  if (item.type === "reasoning") {
    const content = Array.isArray(item.content)
      ? extractTextParts(item.content).map((part) => ({ type: "input_text", text: part.text }))
      : undefined;
    if (content && content.length === 0) return [];
    const cleaned = { type: "reasoning" };
    if (content) cleaned.content = content;
    return [cleaned];
  }

  if (item.type === "web_search_call") {
    return [item];
  }

  if (!EXTERNAL_SUPPORTED_INPUT_TYPES.has(item.type)) {
    // Drop Codex-only inter-agent / encrypted transport items that DeepSeek ignores.
    return [];
  }

  return [item];
}

function rewriteExternalInput(input, compactionSecret, options = {}) {
  if (!Array.isArray(input)) return input;
  const withLocal = rewriteLocalCompactions(input, compactionSecret);
  const rewritten = repairToolCallPairs(
    withLocal.flatMap((item) => sanitizeExternalInputItem(item)),
  );
  if (options.ensureCompactionPrompt
    && !rewritten.some((item) => item?.type === "message"
      && Array.isArray(item.content)
      && item.content.some((part) => typeof part?.text === "string"
        && part.text.includes("CONTEXT CHECKPOINT COMPACTION")))) {
    rewritten.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }],
    });
  }
  return rewritten;
}

export function rewriteRequestBody(body, selection, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const rewritten = structuredClone(body);
  if (selection.kind !== "external") {
    // The native upstream cannot decrypt router-sealed summaries, so restore
    // them to plaintext before forwarding. Compactions encrypted by ChatGPT
    // itself stay untouched for the native backend to verify.
    rewritten.input = rewriteLocalCompactions(rewritten.input, options.compactionSecret);
    return rewritten;
  }

  rewritten.model = selection.upstreamModel;
  const adaptCompaction = isRemoteCompactionV2Request(body, selection, options);
  rewritten.input = rewriteExternalInput(rewritten.input, options.compactionSecret, {
    ensureCompactionPrompt: adaptCompaction,
  });
  if (adaptCompaction) {
    // DeepSeek's Responses endpoint treats compaction_trigger as an ordinary
    // item. Force a text-only summary turn; its SSE is adapted after the call.
    rewritten.tools = [];
    delete rewritten.tool_choice;
  }
  // Local OpenAI-compatible servers commonly reject OpenAI billing-only fields.
  delete rewritten.service_tier;
  return rewritten;
}

export function externalUpstreamPath(pathname) {
  if (isCompactEndpoint(pathname)) return "/v1/responses";
  return pathname.startsWith("/v1/") ? pathname : `/v1${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function parseSseEvents(payload) {
  return payload.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });
}

function completedSummary(response) {
  return (response?.output ?? [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content?.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

export function adaptCompactionSse(payload, secret) {
  const events = parseSseEvents(payload);
  const completed = events.findLast((event) => event?.type === "response.completed");
  if (!completed?.response) {
    throw new Error("Compaction upstream closed before response.completed");
  }
  const generatedSummary = completedSummary(completed.response);
  if (!generatedSummary) throw new Error("Compaction upstream returned no summary text");

  const item = {
    type: "compaction",
    encrypted_content: sealLocalCompaction(`${SUMMARY_PREFIX}\n${generatedSummary}`, secret),
  };
  const outputDone = {
    type: "response.output_item.done",
    item,
    output_index: 0,
    sequence_number: 0,
  };
  const completedEvent = structuredClone(completed);
  completedEvent.response.output = [item];
  completedEvent.sequence_number = 1;
  return `event: response.output_item.done\ndata: ${JSON.stringify(outputDone)}\n\nevent: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`;
}

export function forwardRequestHeaders(incoming, selection, env = process.env, resolvedToken) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  if (selection.kind === "external") {
    headers.delete("authorization");
    headers.delete("chatgpt-account-id");
    headers.delete("x-api-key");
    const auth = selection.route.auth ?? { mode: "none" };
    if (auth.mode === "bearer_env") {
      const token = env[auth.env];
      if (!token) throw new Error(`Missing external auth environment variable: ${auth.env}`);
      headers.set("authorization", `Bearer ${token}`);
    } else if (auth.mode === "bearer_keychain") {
      if (!resolvedToken) throw new Error("Missing external keychain credential");
      headers.set("authorization", `Bearer ${resolvedToken}`);
    }
  }

  headers.set("accept-encoding", "identity");
  return headers;
}

export function forwardResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of upstreamHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function genericInstructions(text, displayName) {
  if (typeof text !== "string") return text;
  return text
    .replace(/You are Codex, an agent based on GPT-5\./g, `You are Codex, powered by ${displayName}.`)
    .replace(/You are Codex, a coding agent based on GPT-5\./g, `You are Codex, a coding agent powered by ${displayName}.`);
}

function cloneExternalModel(template, route, model, priority) {
  const displayName = model.displayName ?? model.id;
  const entry = structuredClone(template);
  entry.slug = `${route.namespace}/${model.id}`;
  entry.display_name = displayName;
  entry.description = model.description ?? `${displayName} routed through ${route.name ?? route.namespace}.`;
  entry.priority = priority;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.context_window = model.contextWindow ?? entry.context_window;
  entry.max_context_window = model.maxContextWindow ?? model.contextWindow ?? entry.max_context_window;
  entry.input_modalities = model.inputModalities ?? ["text"];
  entry.default_reasoning_level = model.defaultReasoningEffort ?? model.reasoningEfforts?.[0] ?? "low";
  entry.supported_reasoning_levels = (model.reasoningEfforts ?? ["low"]).map((effort) => ({
    effort,
    description: `${displayName} ${effort} reasoning`,
  }));
  entry.base_instructions = genericInstructions(entry.base_instructions, displayName);
  if (entry.model_messages?.instructions_template) {
    entry.model_messages.instructions_template = genericInstructions(
      entry.model_messages.instructions_template,
      displayName,
    );
  }
  entry.additional_speed_tiers = [];
  entry.supports_reasoning_summaries = model.supportsReasoningSummaries ?? false;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}

function addBackwardCompatibleFields(model) {
  // Desktop and the bundled CLI may briefly be on adjacent releases. The
  // 0.144 CLI requires these fields, while newer Desktop catalogs omit them.
  if (!("supports_reasoning_summaries" in model)) {
    model.supports_reasoning_summaries = true;
  }
  if (!("multi_agent_version" in model)) model.multi_agent_version = null;
  if (!("tool_mode" in model)) model.tool_mode = null;
  return model;
}

export function mergeCatalog(nativeCatalog, config, now = new Date()) {
  if (!nativeCatalog || !Array.isArray(nativeCatalog.models) || nativeCatalog.models.length === 0) {
    throw new Error("Native Codex catalog has no model template");
  }

  const catalog = structuredClone(nativeCatalog);
  catalog.models = catalog.models.map(addBackwardCompatibleFields);
  const nativeSlugs = new Set(catalog.models.map((model) => model.slug));
  const template = catalog.models.find((model) => model.slug === "gpt-5.4-mini") ?? catalog.models[0];
  let priority = Math.max(...catalog.models.map((model) => Number(model.priority) || 0), 0) + 1;

  for (const route of config.routes ?? []) {
    for (const model of route.models ?? []) {
      const slug = `${route.namespace}/${model.id}`;
      if (nativeSlugs.has(slug)) throw new Error(`Catalog slug collision: ${slug}`);
      catalog.models.push(cloneExternalModel(template, route, model, priority));
      nativeSlugs.add(slug);
      priority += 1;
    }
  }

  catalog.fetched_at = now.toISOString();
  catalog.etag = `W/\"router-${createHash("sha256")
    .update(JSON.stringify(catalog.models.map(({ slug, display_name: displayName }) => ({ slug, displayName }))))
    .digest("hex")
    .slice(0, 24)}\"`;
  return catalog;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function setTomlTableKey(source, table, key, value) {
  const lines = source.split(/\r?\n/);
  const tablePattern = new RegExp(`^\\s*\\[${table.replaceAll(".", "\\\\.")}\\]\\s*$`);
  const keyPattern = new RegExp(`^(\\s*)${key}\\s*=`);
  const tableStart = lines.findIndex((line) => tablePattern.test(line));

  if (tableStart === -1) {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push("", `[${table}]`, `${key} = ${value}`);
    return lines.join("\n");
  }

  let tableEnd = lines.length;
  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      tableEnd = index;
      break;
    }
  }
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    const match = lines[index].match(keyPattern);
    if (match) {
      lines[index] = `${match[1]}${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(tableStart + 1, 0, `${key} = ${value}`);
  return lines.join("\n");
}

export function patchCodexConfig(source, options) {
  const lines = source.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const rootKeys = new Set(["model_provider", "model_catalog_json", "openai_base_url"]);
  const root = lines.slice(0, rootEnd).filter((line) => {
    if (line.trim() === "# Managed by codex-native-model-router. Keep the built-in provider identity.") {
      return false;
    }
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    return !match || !rootKeys.has(match[1]);
  });
  const removedSections = new Set([
    ...(options.removeSections ?? []),
    ...(options.profile?.name ? [`profiles.${options.profile.name}`] : []),
  ]);
  let skipSection = false;
  const rest = lines.slice(rootEnd).filter((line) => {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) skipSection = removedSections.has(sectionMatch[1]);
    return !skipSection;
  });
  while (root.length > 0 && root[root.length - 1] === "") root.pop();
  const managed = [
    "# Managed by codex-native-model-router. Keep the built-in provider identity.",
    'model_provider = "openai"',
    `model_catalog_json = ${tomlString(options.catalogPath)}`,
    `openai_base_url = ${tomlString(options.routerBaseUrl)}`,
    "",
  ];
  const patched = [...managed, ...root, "", ...rest]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return setTomlTableKey(patched, "features", "enable_request_compression", "false");
}
