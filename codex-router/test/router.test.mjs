import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptCompactionSse,
  externalUpstreamPath,
  forwardRequestHeaders,
  hasLocalCompaction,
  isCompactEndpoint,
  isRemoteCompactionV2Request,
  mergeCatalog,
  openLocalCompaction,
  patchCodexConfig,
  rewriteRequestBody,
  sealLocalCompaction,
  selectRoute,
  upstreamUrl,
} from "../src/lib.mjs";

const config = {
  native: { baseUrl: "https://chatgpt.com/backend-api/codex" },
  routes: [{
    namespace: "deepseek",
    name: "DeepSeek Official API",
    baseUrl: "https://api.deepseek.com",
    auth: { mode: "bearer_keychain", service: "router.deepseek", account: "api-key" },
    models: [{
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 1048576,
      defaultReasoningEffort: "high",
      supportsReasoningSummaries: false,
      reasoningEfforts: ["low", "high", "max"],
    }],
  }],
};

test("routes namespaced models and preserves native model names", () => {
  assert.deepEqual(selectRoute("deepseek/deepseek-v4-flash", config), {
    kind: "external",
    route: config.routes[0],
    upstreamModel: "deepseek-v4-flash",
  });
  assert.deepEqual(selectRoute("gpt-5.6-sol", config), {
    kind: "native",
    route: config.native,
    upstreamModel: "gpt-5.6-sol",
  });
  assert.deepEqual(selectRoute("unknown/model", config), {
    kind: "unknown",
    upstreamModel: "unknown/model",
  });
});

test("joins Codex and OpenAI-compatible upstream paths", () => {
  assert.equal(
    upstreamUrl("https://chatgpt.com/backend-api/codex", "/v1/responses?foo=bar"),
    "https://chatgpt.com/backend-api/codex/responses?foo=bar",
  );
  assert.equal(upstreamUrl("https://api.deepseek.com", "/responses"), "https://api.deepseek.com/responses");
});

test("strips namespace and OpenAI-only service tier for external requests", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  assert.deepEqual(rewriteRequestBody({ model: "deepseek/deepseek-v4-flash", service_tier: "fast", input: "hi" }, selection), {
    model: "deepseek-v4-flash",
    input: "hi",
  });
});

test("converts DeepSeek compaction triggers into an explicit text-only summary turn", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const body = {
    model: "deepseek/deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: [] }, { type: "compaction_trigger" }],
    tools: [{ type: "function", name: "shell" }],
    tool_choice: "auto",
  };
  assert.equal(isRemoteCompactionV2Request(body, selection), true);
  const rewritten = rewriteRequestBody(body, selection, { compactionSecret: "test-secret" });
  assert.equal(rewritten.input.at(-1).type, "message");
  assert.equal(rewritten.input.at(-1).role, "user");
  assert.match(rewritten.input.at(-1).content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
  assert.deepEqual(rewritten.tools, []);
  assert.equal(rewritten.tool_choice, undefined);
});

test("maps /responses/compact onto a DeepSeek text-only summary turn", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  assert.equal(isCompactEndpoint("/v1/responses/compact"), true);
  assert.equal(externalUpstreamPath("/v1/responses/compact"), "/v1/responses");
  const body = {
    model: "deepseek/deepseek-v4-flash",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Long session history." }],
    }],
    tools: [{ type: "function", name: "shell" }],
  };
  assert.equal(isRemoteCompactionV2Request(body, selection, { compactEndpoint: true }), true);
  const rewritten = rewriteRequestBody(body, selection, {
    compactionSecret: "test-secret",
    compactEndpoint: true,
  });
  assert.match(rewritten.input.at(-1).content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
  assert.deepEqual(rewritten.tools, []);
});

test("strips OpenAI encrypted function outputs and agent_message before DeepSeek", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const rewritten = rewriteRequestBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/child",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "gAAAAA-ciphertext" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "encrypted_content", encrypted_content: "gAAAAA-function-output" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: [
          { type: "input_text", text: "shell ok" },
          { type: "encrypted_content", encrypted_content: "gAAAAA-drop-me" },
        ],
      },
      {
        type: "reasoning",
        encrypted_content: "gAAAAA-reasoning",
        content: [{ type: "input_text", text: "keep this thought" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue." }],
      },
    ],
  }, selection, { compactionSecret: "test-secret" });

  assert.deepEqual(rewritten.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" }],
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "tool",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "shell ok",
    },
    {
      type: "reasoning",
      content: [{ type: "input_text", text: "keep this thought" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue." }],
    },
  ]);
});

test("maps Codex custom_tool_call pairs onto DeepSeek function_call pairs", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const rewritten = rewriteRequestBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_00_DB8EHUmSGOXfFxqBhzwe3014",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch\n",
        status: "completed",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_00_DB8EHUmSGOXfFxqBhzwe3014",
        output: "Exit code: 0\nSuccess.",
      },
    ],
  }, selection, { compactionSecret: "test-secret" });

  assert.deepEqual(rewritten.input, [
    {
      type: "function_call",
      call_id: "call_00_DB8EHUmSGOXfFxqBhzwe3014",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch\n" }),
    },
    {
      type: "function_call_output",
      call_id: "call_00_DB8EHUmSGOXfFxqBhzwe3014",
      output: "Exit code: 0\nSuccess.",
    },
  ]);
});

test("encrypts local summaries and restores them as user context for DeepSeek", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const summary = "A private summary with decisions.";
  const sealed = sealLocalCompaction(summary, "test-secret");
  assert.doesNotMatch(sealed, /private summary/);
  assert.equal(openLocalCompaction(sealed, "test-secret"), summary);
  assert.throws(() => openLocalCompaction(sealed, "wrong-secret"), /decrypt/);

  const rewritten = rewriteRequestBody({
    model: "deepseek/deepseek-v4-flash",
    input: [{ type: "compaction", encrypted_content: sealed }],
  }, selection, { compactionSecret: "test-secret" });
  assert.deepEqual(rewritten.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: summary }],
  }]);
});

test("drops opaque compactions created by another provider when switching to DeepSeek", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const currentMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Continue with DeepSeek." }],
  };
  const rewritten = rewriteRequestBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      { type: "compaction", encrypted_content: "opaque-openai-compaction" },
      currentMessage,
    ],
  }, selection, { compactionSecret: "test-secret" });

  assert.deepEqual(rewritten.input, [currentMessage]);
});

test("restores router-sealed summaries for native GPT requests", () => {
  const selection = selectRoute("gpt-5.6-sol", config);
  const summary = "A private summary from a DeepSeek compaction.";
  const sealed = sealLocalCompaction(summary, "test-secret");
  const currentMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Continue with GPT." }],
  };

  assert.equal(hasLocalCompaction([{ type: "compaction", encrypted_content: sealed }]), true);
  assert.equal(hasLocalCompaction([{ type: "compaction", encrypted_content: "opaque" }]), false);

  const rewritten = rewriteRequestBody({
    model: "gpt-5.6-sol",
    input: [{ type: "compaction", encrypted_content: sealed }, currentMessage],
  }, selection, { compactionSecret: "test-secret" });
  assert.deepEqual(rewritten, {
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: summary }],
    }, currentMessage],
  });
});

test("keeps ChatGPT-encrypted compactions untouched for native GPT requests", () => {
  const selection = selectRoute("gpt-5.6-sol", config);
  const opaque = { type: "compaction", encrypted_content: "opaque-openai-compaction" };
  const rewritten = rewriteRequestBody({
    model: "gpt-5.6-sol",
    input: [opaque],
  }, selection);

  assert.deepEqual(rewritten.input, [opaque]);
});

test("does not require a compaction secret for native requests without local compactions", () => {
  const selection = selectRoute("gpt-5.6-sol", config);
  const message = { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] };
  const rewritten = rewriteRequestBody({
    model: "gpt-5.6-sol",
    input: [message],
  }, selection);

  assert.deepEqual(rewritten.input, [message]);
});

test("adapts a DeepSeek SSE response into exactly one Codex compaction item", () => {
  const upstream = [
    "event: response.output_item.done",
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning" } })}`,
    "",
    "event: response.output_item.done",
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message" } })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response-1",
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "Keep the blue decision." }],
        }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      sequence_number: 9,
    })}`,
    "",
  ].join("\n");
  const adapted = adaptCompactionSse(upstream, "test-secret");
  const events = adapted
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
  const outputItems = events.filter((event) => event.type === "response.output_item.done");
  assert.equal(outputItems.length, 1);
  assert.equal(outputItems[0].item.type, "compaction");
  assert.match(openLocalCompaction(outputItems[0].item.encrypted_content, "test-secret"), /blue decision/);
  assert.deepEqual(events[1].response.output, [outputItems[0].item]);
  assert.equal(events[1].response.usage.total_tokens, 15);
});

test("does not leak ChatGPT credentials to an external route", () => {
  const selection = selectRoute("deepseek/deepseek-v4-flash", config);
  const headers = forwardRequestHeaders({
    authorization: "Bearer chatgpt-secret",
    "chatgpt-account-id": "account",
    "content-type": "application/json",
  }, selection, {}, "deepseek-secret");
  assert.equal(headers.get("authorization"), "Bearer deepseek-secret");
  assert.equal(headers.has("chatgpt-account-id"), false);
  assert.equal(headers.get("content-type"), "application/json");
});

test("merges external models into the ModelsCache wrapper", () => {
  const native = {
    fetched_at: "old",
    etag: "old",
    client_version: "0.144.1",
    models: [{
      slug: "gpt-5.4-mini",
      display_name: "GPT-5.4 mini",
      priority: 1,
      max_context_window: 272000,
      service_tiers: [{ id: "priority" }],
      additional_speed_tiers: ["fast"],
      base_instructions: "You are Codex, an agent based on GPT-5.",
    }],
  };
  const merged = mergeCatalog(native, config, new Date("2026-08-05T00:00:00Z"));
  assert.deepEqual(Object.keys(merged).sort(), ["client_version", "etag", "fetched_at", "models"]);
  assert.equal(merged.models[1].slug, "deepseek/deepseek-v4-flash");
  assert.equal(merged.models[1].display_name, "DeepSeek V4 Flash");
  assert.equal(merged.models[1].service_tiers, undefined);
  assert.deepEqual(merged.models[1].additional_speed_tiers, []);
  assert.equal(merged.models[0].supports_reasoning_summaries, true);
  assert.equal(merged.models[1].supports_reasoning_summaries, false);
  assert.equal(merged.models[1].default_reasoning_level, "high");
  assert.deepEqual(
    merged.models[1].supported_reasoning_levels.map(({ effort }) => effort),
    ["low", "high", "max"],
  );
  assert.equal(merged.models[1].context_window, 1048576);
  assert.equal(merged.models[1].max_context_window, 1048576);
  assert.equal(merged.models[1].multi_agent_version, null);
  assert.equal(merged.models[1].tool_mode, null);
  assert.match(merged.models[1].base_instructions, /powered by DeepSeek V4 Flash/);
});

test("patches only managed root keys and preserves unrelated profiles", () => {
  const source = `model = "gpt-5.6-sol"

[features]
enable_request_compression = true

[profiles.qwen-llama]
model = "qwen3-coder"
model_provider = "qwen-llama"

[model_providers.qwen-llama]
name = "Qwen"
base_url = "http://127.0.0.1:8001/v1"
`;
  const patched = patchCodexConfig(source, {
    catalogPath: "/tmp/catalog.json",
    routerBaseUrl: "http://127.0.0.1:10100/v1",
    routes: config.routes,
    profile: { name: "deepseek", model: "deepseek/deepseek-v4-flash" },
  });
  assert.match(patched, /^# Managed by[\s\S]*model_provider = "openai"/);
  assert.match(patched, /model_catalog_json = "\/tmp\/catalog.json"/);
  assert.match(patched, /\[features\]\nenable_request_compression = false/);
  assert.match(patched, /\[profiles\.qwen-llama\]\nmodel = "qwen3-coder"\nmodel_provider = "qwen-llama"/);
  assert.match(patched, /\[model_providers\.qwen-llama\]/);
  assert.doesNotMatch(patched, /\[profiles\.deepseek\]/);
  assert.equal((patched.match(/model_provider = "openai"/g) ?? []).length, 1);
  assert.equal((patched.match(/model_provider = "qwen-llama"/g) ?? []).length, 1);
  assert.equal(patchCodexConfig(patched, {
    catalogPath: "/tmp/catalog.json",
    routerBaseUrl: "http://127.0.0.1:10100/v1",
    routes: config.routes,
    profile: { name: "deepseek", model: "deepseek/deepseek-v4-flash" },
  }), patched);
});

test("adds the compression feature table when it is absent", () => {
  const patched = patchCodexConfig('model = "gpt-5.6-sol"\n', {
    catalogPath: "/tmp/catalog.json",
    routerBaseUrl: "http://127.0.0.1:10100/v1",
    routes: config.routes,
  });
  assert.match(patched, /\[features\]\nenable_request_compression = false/);
});
