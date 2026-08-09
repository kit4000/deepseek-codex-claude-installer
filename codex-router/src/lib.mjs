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

export function isRemoteCompactionV2Request(body, selection) {
  return selection.kind === "external"
    && Array.isArray(body?.input)
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

function rewriteExternalInput(input, compactionSecret) {
  if (!Array.isArray(input)) return input;
  const withLocal = rewriteLocalCompactions(input, compactionSecret);
  return withLocal.flatMap((item) => {
    if (item?.type === "compaction_trigger") {
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: SUMMARIZATION_PROMPT }],
      }];
    }
    if (item?.type === "compaction") {
      // Compactions produced by ChatGPT or another provider are opaque to this
      // router. They cannot be forwarded to DeepSeek or decrypted locally, so
      // omit them and preserve the ordinary messages that follow the provider
      // switch. Router-produced compactions were restored by
      // rewriteLocalCompactions above.
      return [];
    }
    return [item];
  });
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
  rewritten.input = rewriteExternalInput(rewritten.input, options.compactionSecret);
  if (isRemoteCompactionV2Request(body, selection)) {
    // DeepSeek's Responses endpoint treats compaction_trigger as an ordinary
    // item. Force a text-only summary turn; its SSE is adapted after the call.
    rewritten.tools = [];
    delete rewritten.tool_choice;
  }
  // Local OpenAI-compatible servers commonly reject OpenAI billing-only fields.
  delete rewritten.service_tier;
  return rewritten;
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
