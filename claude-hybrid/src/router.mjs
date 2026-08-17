#!/usr/bin/env node

import http from "node:http";
import { execFile } from "node:child_process";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  anthropicToOpenAIChatCompletions,
  createOpenAIToAnthropicStreamTranslator,
  openaiChatToAnthropicMessage,
  openaiErrorToAnthropic,
  parseOpenAISseFrame,
  splitSseFrames,
} from "./openai-messages.mjs";

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const CREDENTIAL_TTL_MS = 60 * 60 * 1000;
const NATIVE_MODEL_LIST_TIMEOUT_MS = 10_000;

function normalizeBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

function externalModelEntries(config) {
  return config?.models?.external ?? [];
}

export function externalModelFor(config, model) {
  if (typeof model !== "string") return undefined;
  return externalModelEntries(config).find((entry) =>
    entry.id === model || entry.aliases?.includes(model) || entry.target === model);
}

export function providerForModel(config, model) {
  if (typeof model !== "string" || model.length === 0) return "native";
  const entry = externalModelFor(config, model);
  if (entry?.provider === "openai" || entry?.provider === "deepseek") return entry.provider;
  if (entry) return "deepseek";
  return "native";
}

export function isExternalModel(config, model) {
  return providerForModel(config, model) !== "native";
}

function copyRequestHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const normalized = name.toLowerCase();
    if (["connection", "content-length", "host", "transfer-encoding"].includes(normalized)) {
      continue;
    }
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function copyResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function targetUrl(baseUrl, pathname, search = "") {
  const base = normalizeBase(baseUrl);
  return `${base}${pathname}${search}`;
}

function externalModelRecord(entry, index) {
  return {
    type: "model",
    id: entry.id,
    display_name: entry.displayName ?? entry.id,
    created_at: `2026-01-01T00:00:00.000Z`,
    owned_by: entry.provider ?? "deepseek",
    ...(entry.target?.includes("[1m]") || entry.id?.includes("[1m]") ? { supports_1m: true } : {}),
  };
}

function nativeFallbackRecords(config) {
  return (config.models?.nativeFallback ?? []).map((entry) => ({
    type: "model",
    id: entry.id,
    display_name: entry.displayName ?? entry.id,
    created_at: "2025-01-01T00:00:00.000Z",
    owned_by: "anthropic",
  }));
}

async function collectModelList(config, incomingHeaders, fetchImpl) {
  const nativeUrl = targetUrl(config.native.baseUrl, "/v1/models");
  try {
    const upstream = await fetchImpl(nativeUrl, {
      method: "GET",
      headers: copyRequestHeaders(incomingHeaders),
      redirect: "error",
      signal: AbortSignal.timeout(NATIVE_MODEL_LIST_TIMEOUT_MS),
    });
    if (upstream.ok) {
      const payload = await upstream.json();
      if (Array.isArray(payload.data) && payload.data.length > 0) {
        return payload.data.map((entry) => ({
          type: "model",
          id: entry.id,
          display_name: entry.display_name ?? entry.id,
          created_at: entry.created_at ?? "2025-01-01T00:00:00.000Z",
          owned_by: entry.owned_by ?? "anthropic",
        }));
      }
    }
  } catch {}
  return nativeFallbackRecords(config);
}

export function createCredentialReader(config, options = {}) {
  const { execImpl = execFileAsync, now = Date.now, provider = "deepseek" } = options;
  const spec = provider === "openai" ? config.openai : config.deepseek;
  const label = provider === "openai" ? "OpenAI" : "DeepSeek";
  let cached = { token: "", expiresAt: 0 };
  return async function readProviderKey() {
    if (cached.token && cached.expiresAt > now()) return cached.token;
    const helper = spec?.credentialHelper;
    if (typeof helper !== "string" || helper.length === 0) {
      throw new Error(`${label} credential helper is not configured`);
    }
    const { stdout } = await execImpl(helper, [], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const token = stdout.trim();
    if (!token) throw new Error(`${label} credential helper returned an empty key`);
    cached = { token, expiresAt: now() + CREDENTIAL_TTL_MS };
    return token;
  };
}

function rejectUpgrade(_request, socket) {
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
}

function listenOn(server, ...args) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(...args, () => {
      server.off("error", rejectListen);
      resolveListen(server.address());
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function listenUnixSocket(server, socketPath) {
  await mkdir(dirname(socketPath), { recursive: true });
  try {
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const address = await listenOn(server, socketPath);
  await chmod(socketPath, 0o600);
  return address;
}

export function requestUnix(socketPath, {
  method = "GET",
  path = "/",
  headers = {},
  body,
  timeoutMs = 3000,
} = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({
      socketPath,
      path,
      method,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolveRequest({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on("error", rejectRequest);
    request.on("timeout", () => {
      request.destroy();
      rejectRequest(new Error("unix socket request timed out"));
    });
    if (body === undefined) request.end();
    else request.end(body);
  });
}

function routeBodyPath(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  return {
    pathname: url.pathname,
    search: url.search,
    isModelList: url.pathname === "/v1/models",
    isSingleModel: /^\/v1\/models\/[^/]+$/.test(url.pathname),
    isMessages: url.pathname === "/v1/messages",
    isCountTokens: url.pathname === "/v1/messages/count_tokens",
  };
}

async function pipeOpenAIChatStream(upstream, response, requestModel) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  const translator = createOpenAIToAnthropicStreamTranslator({
    id: `msg_openai_${Date.now()}`,
    model: requestModel,
  });
  for (const event of translator.start()) response.write(event);
  if (!upstream.body) {
    for (const event of translator.finish()) response.write(event);
    response.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += chunk.toString("utf8");
      const split = splitSseFrames(buffer);
      buffer = split.remaining;
      for (const frame of split.frames) {
        const parsedFrame = parseOpenAISseFrame(frame);
        if (!parsedFrame) continue;
        if (parsedFrame.done) {
          for (const event of translator.finish()) response.write(event);
          response.end();
          return;
        }
        for (const event of translator.pushChunk(parsedFrame.chunk)) response.write(event);
      }
    }
    for (const event of translator.finish()) response.write(event);
    response.end();
  } catch (error) {
    stream.destroy();
    if (!response.writableEnded) response.destroy(error);
  }
}

export function createHybridRouter({
  config,
  fetchImpl = fetch,
  keychainReader,
  openaiKeychainReader,
  logger = console,
}) {
  const readKey = keychainReader ?? createCredentialReader(config, { provider: "deepseek" });
  const readOpenAIKey = openaiKeychainReader ?? createCredentialReader(config, { provider: "openai" });

  async function forward(request, response, route, body) {
    const baseUrl = route.external ? config.deepseek.baseUrl : config.native.baseUrl;
    const headers = copyRequestHeaders(request.headers);
    if (route.external) {
      const key = await readKey();
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${key}`);
    }

    const payload = body.length > 0 ? body : undefined;
    const target = targetUrl(baseUrl, route.pathname, route.search);
    const abortController = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abortController.abort();
    });

    const upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: payload,
      redirect: "manual",
      signal: abortController.signal,
    });

    logger.info?.(`claude-hybrid ${route.external ? "deepseek" : "native"} ${request.method} ${route.pathname} -> ${upstream.status}`);
    response.writeHead(upstream.status, copyResponseHeaders(upstream.headers));
    if (!upstream.body) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", (streamError) => {
      if (streamError?.name === "AbortError") {
        if (!response.writableEnded) response.destroy();
        return;
      }
      if (!response.writableEnded) response.destroy(streamError);
    });
    response.on("error", () => stream.destroy());
    stream.pipe(response);
  }

  async function handleModelList(request, response) {
    const nativeModels = await collectModelList(config, request.headers, fetchImpl);
    const externalModels = externalModelEntries(config).map(externalModelRecord);
    logger.info?.(
      `claude-hybrid native GET /v1/models -> ${nativeModels.length} native + ${externalModels.length} external`,
    );
    sendJson(response, 200, { data: [...nativeModels, ...externalModels] });
  }

  async function handleSingleModel(request, response) {
    const url = new URL(request.url, "http://localhost");
    const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    const external = externalModelFor(config, id);
    if (external) {
      sendJson(response, 200, { data: externalModelRecord(external, 0) });
      return;
    }
    const target = targetUrl(config.native.baseUrl, url.pathname, url.search);
    const upstream = await fetchImpl(target, {
      method: "GET",
      headers: copyRequestHeaders(request.headers),
      redirect: "error",
      signal: AbortSignal.timeout(NATIVE_MODEL_LIST_TIMEOUT_MS),
    });
    logger.info?.(`claude-hybrid native GET ${url.pathname} -> ${upstream.status}`);
    response.writeHead(upstream.status, copyResponseHeaders(upstream.headers));
    const stream = Readable.fromWeb(upstream.body);
    stream.pipe(response);
  }

  async function handleCountTokens(request, response, body) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(response, 400, {
        error: { message: "Expected a JSON request body", type: "invalid_request_error" },
      });
      return;
    }
    if (!isExternalModel(config, parsed.model)) {
      await forward(request, response, { external: false, pathname: "/v1/messages/count_tokens", search: "" }, body);
      return;
    }
    if (providerForModel(config, parsed.model) === "openai") {
      const estimate = Math.max(1, Math.ceil(body.toString("utf8").length / 4));
      sendJson(response, 200, { input_tokens: estimate });
      return;
    }

    const target = targetUrl(config.deepseek.baseUrl, "/v1/messages/count_tokens", "");
    const headers = copyRequestHeaders(request.headers);
    const key = await readKey();
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${key}`);
    const entry = externalModelFor(config, parsed.model);
    if (entry?.target) parsed.model = entry.target;
    const forwardBody = Buffer.from(JSON.stringify(parsed), "utf8");
    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        headers,
        body: forwardBody,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (upstream.ok || ![404, 405, 501].includes(upstream.status)) {
        response.writeHead(upstream.status, copyResponseHeaders(upstream.headers));
        const stream = Readable.fromWeb(upstream.body);
        stream.pipe(response);
        return;
      }
    } catch {}

    const estimate = Math.max(1, Math.ceil(body.toString("utf8").length / 4));
    sendJson(response, 200, { input_tokens: estimate });
  }

  async function handleOpenAIMessages(request, response, parsed, requestModel) {
    if (!config.openai?.baseUrl) {
      sendJson(response, 400, {
        error: { message: "OpenAI provider is not configured", type: "invalid_request_error" },
      });
      return;
    }
    const entry = externalModelFor(config, requestModel);
    const openaiBody = anthropicToOpenAIChatCompletions(parsed, entry?.target ?? requestModel);
    const key = await readOpenAIKey();
    const headers = new Headers({
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    });
    const abortController = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    const upstream = await fetchImpl(targetUrl(config.openai.baseUrl, "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(openaiBody),
      redirect: "error",
      signal: abortController.signal,
    });
    logger.info?.(`claude-hybrid openai POST /v1/messages -> ${upstream.status}`);
    if (!upstream.ok) {
      const mapped = openaiErrorToAnthropic(upstream.status, await upstream.text());
      sendJson(response, mapped.status, mapped.payload);
      return;
    }
    if (openaiBody.stream) {
      await pipeOpenAIChatStream(upstream, response, requestModel);
      return;
    }
    sendJson(response, 200, openaiChatToAnthropicMessage(await upstream.json(), requestModel));
  }

  async function handleRequest(request, response) {
    try {
      if (request.method === "GET" && ["/", "/v1", "/healthz"].includes(request.url)) {
        sendJson(response, 200, {
          ok: true,
          provider: "claude-hybrid",
          routes: {
            native: config.native.baseUrl,
            deepseek: config.deepseek.baseUrl,
            openai: config.openai?.baseUrl ?? null,
          },
          socketPath: config.router.socketPath ?? null,
        });
        return;
      }

      const route = routeBodyPath(request.url);
      if (request.method === "GET" && route.isModelList) {
        await handleModelList(request, response);
        return;
      }
      if (request.method === "GET" && route.isSingleModel) {
        await handleSingleModel(request, response);
        return;
      }

      const body = await readBody(request);
      if (route.isMessages) {
        let parsed;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          sendJson(response, 400, {
            error: { message: "Expected a JSON request body", type: "invalid_request_error" },
          });
          return;
        }
        const provider = providerForModel(config, parsed.model);
        if (provider === "openai") {
          await handleOpenAIMessages(request, response, parsed, parsed.model);
          return;
        }
        let forwardBody = body;
        if (provider === "deepseek") {
          const entry = externalModelFor(config, parsed.model);
          parsed.model = entry?.target ?? parsed.model;
          forwardBody = Buffer.from(JSON.stringify(parsed), "utf8");
        }
        await forward(
          request,
          response,
          { external: provider === "deepseek", pathname: route.pathname, search: route.search },
          forwardBody,
        );
        return;
      }
      if (route.isCountTokens) {
        await handleCountTokens(request, response, body);
        return;
      }

      const external = request.method === "POST" ? isExternalModel(config, undefined) : false;
      await forward(request, response, { external, pathname: route.pathname, search: route.search }, body);
    } catch (error) {
      if (error?.name === "AbortError") {
        if (!response.writableEnded) response.destroy();
        return;
      }
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      logger.error?.("claude-hybrid router error", {
        name: error?.name,
        message: error?.message,
      });
      sendJson(response, error?.statusCode ?? 502, {
        error: {
          message: error?.message ?? "The selected model provider is temporarily unavailable",
          type: error?.code ?? "provider_unavailable",
        },
      });
    }
  }

  const server = http.createServer(handleRequest);
  const unixServer = http.createServer(handleRequest);
  server.on("upgrade", rejectUpgrade);
  unixServer.on("upgrade", rejectUpgrade);

  return {
    server,
    unixServer,
    async listen() {
      const tcp = await listenOn(server, config.router.port, config.router.host);
      let unix = null;
      const socketPath = config.router.socketPath;
      if (typeof socketPath === "string" && socketPath.length > 0) {
        try {
          unix = await listenUnixSocket(unixServer, socketPath);
        } catch (error) {
          await closeServer(server);
          throw error;
        }
      }
      return { tcp, unix };
    },
    async close() {
      await closeServer(unixServer);
      await closeServer(server);
    },
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? new URL("../config/claude-hybrid.json", import.meta.url);
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.deepseek?.credentialHelper?.includes("<home>")) {
    config.deepseek.credentialHelper = config.deepseek.credentialHelper.replaceAll("<home>", process.env.HOME);
  }
  if (config.openai?.credentialHelper?.includes("<home>")) {
    config.openai.credentialHelper = config.openai.credentialHelper.replaceAll("<home>", process.env.HOME);
  }
  if (config.router?.socketPath?.includes("<home>")) {
    config.router.socketPath = config.router.socketPath.replaceAll("<home>", process.env.HOME);
  }
  const router = createHybridRouter({ config });
  const address = await router.listen();
  const tcp = `${address.tcp.address}:${address.tcp.port}`;
  const unix = address.unix ? ` and unix ${config.router.socketPath}` : "";
  console.log(`Claude Hybrid router listening on ${tcp}${unix}`);
}
