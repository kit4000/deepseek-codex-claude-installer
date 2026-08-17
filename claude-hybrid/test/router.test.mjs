import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHybridRouter, isExternalModel, providerForModel, requestUnix } from "../src/router.mjs";

const config = {
  router: { host: "127.0.0.1", port: 0 },
  native: { baseUrl: "https://api.anthropic.com" },
  deepseek: {
    baseUrl: "https://api.deepseek.com/anthropic",
    credentialHelper: "/tmp/helper",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    credentialHelper: "/tmp/openai-helper",
  },
  models: {
    external: [
      {
        id: "deepseek-v4-pro[1m]",
        aliases: ["claude-opus-4-6", "claude-opus-4-5-external-pro"],
        target: "deepseek-v4-pro[1m]",
        displayName: "DeepSeek V4 Pro (1M)",
        provider: "deepseek",
      },
      {
        id: "deepseek-v4-flash",
        aliases: ["claude-sonnet-4-6", "claude-haiku-4-5-external-flash"],
        target: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        provider: "deepseek",
      },
      {
        id: "gpt-5.6-sol",
        aliases: ["claude-opus-4-8"],
        target: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        provider: "openai",
      },
      {
        id: "gpt-5.6-luna",
        aliases: ["claude-opus-4-7"],
        target: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        provider: "openai",
      },
    ],
    nativeFallback: [
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ],
  },
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("isExternalModel recognizes configured aliases and raw provider ids", () => {
  assert.equal(isExternalModel(config, "deepseek-v4-pro[1m]"), true);
  assert.equal(isExternalModel(config, "deepseek-v4-flash"), true);
  assert.equal(isExternalModel(config, "claude-opus-4-6"), true);
  assert.equal(isExternalModel(config, "claude-sonnet-4-6"), true);
  assert.equal(isExternalModel(config, "claude-opus-4-8"), true);
  assert.equal(isExternalModel(config, "claude-opus-4-7"), true);
  assert.equal(isExternalModel(config, "gpt-5.6-sol"), true);
  assert.equal(isExternalModel(config, "gpt-5.6-luna"), true);
  assert.equal(isExternalModel(config, "claude-fable-5"), false);
  assert.equal(isExternalModel(config, "claude-opus-4-5"), false);
  assert.equal(isExternalModel(config, "claude-sonnet-4-5"), false);
  assert.equal(isExternalModel(config, "claude-opus-5"), false);
  assert.equal(isExternalModel(config, "claude-sonnet-5"), false);
  assert.equal(isExternalModel(config, "claude-haiku-4-5"), false);
  assert.equal(isExternalModel(config, "gpt-unlisted"), false);
  assert.equal(isExternalModel(config, "deepseek-unlisted"), false);
  assert.equal(isExternalModel(config, undefined), false);
});

test("unlisted gpt and deepseek ids stay native unless configured", () => {
  assert.equal(providerForModel(config, "gpt-5.6-sol"), "openai");
  assert.equal(providerForModel(config, "deepseek-v4-flash"), "deepseek");
  assert.equal(providerForModel(config, "gpt-unlisted"), "native");
  assert.equal(providerForModel(config, "deepseek-unlisted"), "native");
  const productionLike = {
    ...config,
    openai: undefined,
    models: {
      ...config.models,
      external: config.models.external.filter((entry) => entry.provider !== "openai"),
    },
  };
  assert.equal(providerForModel(productionLike, "gpt-5.6-sol"), "native");
  assert.equal(providerForModel(productionLike, "claude-opus-4-8"), "native");
});

test("model list combines native discovery with external models", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse(200, {
      data: [
        { id: "claude-opus-4-5", display_name: "Claude Opus 4.5" },
        { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
      ],
    });
  };
  const router = createHybridRouter({ config, fetchImpl, logger: { info() {}, error() {} } });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.length, 6);
    assert.equal(payload.data[2].id, "deepseek-v4-pro[1m]");
    assert.equal(payload.data[3].id, "deepseek-v4-flash");
    assert.equal(payload.data[4].id, "gpt-5.6-sol");
    assert.equal(payload.data[5].id, "gpt-5.6-luna");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native messages are forwarded unchanged", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const router = createHybridRouter({ config, fetchImpl, logger: { info() {}, error() {} } });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer native-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer native-token");
    assert.equal(JSON.parse(calls[0].options.body).model, "claude-opus-5");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("external messages use the DeepSeek key and target model", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const router = createHybridRouter({
    config,
    fetchImpl,
    keychainReader: async () => "deepseek-key",
    logger: { info() {}, error() {} },
  });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer native-token",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer deepseek-key");
    assert.equal(JSON.parse(calls[0].options.body).model, "deepseek-v4-flash");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("external count_tokens falls back to a local estimate", async () => {
  const fetchImpl = async () => new Response("not found", { status: 404 });
  const router = createHybridRouter({
    config,
    fetchImpl,
    keychainReader: async () => "deepseek-key",
    logger: { info() {}, error() {} },
  });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-external-flash", messages: [] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(typeof payload.input_tokens, "number");
    assert.ok(payload.input_tokens >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("response forwarding strips content-encoding so decoded bodies stay readable", async () => {
  const fetchImpl = async () => new Response("plain", {
    status: 200,
    headers: { "content-type": "text/plain", "content-encoding": "gzip" },
  });
  const router = createHybridRouter({ config, fetchImpl, logger: { info() {}, error() {} } });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(await response.text(), "plain");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unix socket serves the same health and native routes as TCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-hybrid-unix-"));
  const socketPath = join(directory, "router.sock");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const router = createHybridRouter({
    config: { ...config, router: { host: "127.0.0.1", port: 0, socketPath } },
    fetchImpl,
    logger: { info() {}, error() {} },
  });
  try {
    const address = await router.listen();
    assert.ok(address.tcp.port > 0);
    const health = await requestUnix(socketPath, { path: "/healthz" });
    assert.equal(health.statusCode, 200);
    const payload = JSON.parse(health.body.toString("utf8"));
    assert.equal(payload.provider, "claude-hybrid");
    assert.equal(payload.socketPath, socketPath);
    const response = await requestUnix(socketPath, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  } finally {
    await router.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenAI aliases use the OpenAI key and Chat Completions translation", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      id: "chatcmpl-test",
      choices: [{ finish_reason: "stop", message: { content: "hello from sol" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
  };
  const router = createHybridRouter({
    config,
    fetchImpl,
    keychainReader: async () => "deepseek-key",
    openaiKeychainReader: async () => "openai-key",
    logger: { info() {}, error() {} },
  });
  const { server } = router;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer native-token" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, "claude-opus-4-8");
    assert.equal(payload.content[0].text, "hello from sol");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer openai-key");
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.model, "gpt-5.6-sol");
    assert.equal(sent.messages.at(-1).content, "hi");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
