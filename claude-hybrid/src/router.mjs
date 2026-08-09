#!/usr/bin/env node

import http from "node:http";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

export function isExternalModel(config, model) {
  if (typeof model !== "string" || model.length === 0) return false;
  if (externalModelEntries(config).some((entry) =>
    entry.id === model || entry.aliases?.includes(model))) return true;
  return model.startsWith("deepseek-");
}

export function externalModelFor(config, model) {
  if (typeof model !== "string") return undefined;
  return externalModelEntries(config).find((entry) =>
    entry.id === model || entry.aliases?.includes(model));
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
    owned_by: "deepseek",
    ...(index === 0 ? { supports_1m: true } : {}),
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
  const { execImpl = execFileAsync, now = Date.now } = options;
  let cached = { token: "", expiresAt: 0 };
  return async function readDeepSeekKey() {
    if (cached.token && cached.expiresAt > now()) return cached.token;
    const helper = config.deepseek?.credentialHelper;
    if (typeof helper !== "string" || helper.length === 0) {
      throw new Error("DeepSeek credential helper is not configured");
    }
    const { stdout } = await execImpl(helper, [], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const token = stdout.trim();
    if (!token) throw new Error("DeepSeek credential helper returned an empty key");
    cached = { token, expiresAt: now() + CREDENTIAL_TTL_MS };
    return token;
  };
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

export function createHybridRouter({
  config,
  fetchImpl = fetch,
  keychainReader,
  logger = console,
}) {
  const readKey = keychainReader ?? createCredentialReader(config);

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

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && ["/", "/v1", "/healthz"].includes(request.url)) {
        sendJson(response, 200, {
          ok: true,
          provider: "claude-hybrid",
          routes: {
            native: config.native.baseUrl,
            deepseek: config.deepseek.baseUrl,
          },
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
        const external = isExternalModel(config, parsed.model);
        let forwardBody = body;
        if (external) {
          const entry = externalModelFor(config, parsed.model);
          parsed.model = entry?.target ?? parsed.model;
          forwardBody = Buffer.from(JSON.stringify(parsed), "utf8");
        }
        await forward(
          request,
          response,
          { external, pathname: route.pathname, search: route.search },
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
  });

  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(config.router.port, config.router.host, () => {
          server.off("error", rejectListen);
          resolveListen(server.address());
        });
      });
    },
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
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
  const router = createHybridRouter({ config });
  const address = await router.listen();
  console.log(`Claude Hybrid router listening on ${address.address}:${address.port}`);
}
