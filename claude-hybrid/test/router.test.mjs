import assert from "node:assert/strict";
import test from "node:test";
import { createHybridRouter, isExternalModel } from "../src/router.mjs";

const config = {
  router: { host: "127.0.0.1", port: 0 },
  native: { baseUrl: "https://api.anthropic.com" },
  deepseek: {
    baseUrl: "https://api.deepseek.com/anthropic",
    credentialHelper: "/tmp/helper",
  },
  models: {
    external: [
      {
        id: "claude-opus-4-5-external-pro",
        aliases: ["claude-opus-4-6"],
        target: "deepseek-v4-pro[1m]",
        displayName: "DeepSeek V4 Pro (1M)",
      },
      {
        id: "claude-haiku-4-5-external-flash",
        aliases: ["claude-sonnet-4-6"],
        target: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
      },
    ],
    nativeFallback: [
      { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
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

test("isExternalModel recognizes configured aliases and raw deepseek ids", () => {
  assert.equal(isExternalModel(config, "claude-opus-4-5-external-pro"), true);
  assert.equal(isExternalModel(config, "claude-haiku-4-5-external-flash"), true);
  assert.equal(isExternalModel(config, "claude-opus-4-6"), true);
  assert.equal(isExternalModel(config, "claude-sonnet-4-6"), true);
  assert.equal(isExternalModel(config, "claude-fable-5"), false);
  assert.equal(isExternalModel(config, "claude-opus-4-8"), false);
  assert.equal(isExternalModel(config, "deepseek-v4-flash"), true);
  assert.equal(isExternalModel(config, "claude-opus-4-5"), false);
  assert.equal(isExternalModel(config, undefined), false);
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
    assert.equal(payload.data.length, 4);
    assert.equal(payload.data[2].id, "claude-opus-4-5-external-pro");
    assert.equal(payload.data[3].id, "claude-haiku-4-5-external-flash");
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
      body: JSON.stringify({ model: "claude-opus-4-5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer native-token");
    assert.equal(JSON.parse(calls[0].options.body).model, "claude-opus-4-5");
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
      body: JSON.stringify({ model: "claude-opus-4-5", messages: [] }),
    });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(await response.text(), "plain");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
