import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  chatCompletionsToResponses,
  createChatToResponsesTransform,
  createChatToResponsesTranslator,
  responsesToChatCompletions,
} from "./chat-completions.mjs";
import {
  adaptCompactionSse,
  externalUpstreamPath,
  forwardRequestHeaders,
  forwardResponseHeaders,
  hasLocalCompaction,
  isCompactEndpoint,
  isRemoteCompactionV2Request,
  rewriteRequestBody,
  selectRoute,
  upstreamUrl,
} from "./lib.mjs";
import { createReasoningContentFilter } from "./sse-filter.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = process.env.CODEX_MODEL_ROUTER_CONFIG ?? `${projectRoot}/router-config.json`;
const config = JSON.parse(await readFile(configPath, "utf8"));
const maxBodyBytes = 32 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function keychainToken(auth) {
  if (auth?.mode !== "bearer_keychain") return undefined;
  const result = spawnSync("/usr/bin/security", [
    "find-generic-password",
    "-s", auth.service,
    "-a", auth.account,
    "-w",
  ], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function handleProxy(request, response, pathname) {
  const rawBody = await readBody(request);
  const contentEncoding = String(request.headers["content-encoding"] ?? "identity").toLowerCase();
  if (contentEncoding !== "identity") {
    return sendJson(response, 415, {
      error: {
        message: "Compressed request bodies are unsupported by the local router",
        type: "unsupported_content_encoding",
      },
    });
  }
  let parsedBody;
  try {
    parsedBody = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendJson(response, 400, { error: { message: "Expected a JSON request body" } });
  }

  const isImageRequest = /\/images\//.test(pathname);
  if (!isImageRequest && typeof parsedBody.model !== "string") {
    return sendJson(response, 400, { error: { message: "A model name is required" } });
  }
  const selection = isImageRequest
    ? { kind: "native", route: config.native, upstreamModel: parsedBody.model }
    : selectRoute(parsedBody.model, config);
  if (selection.kind === "unknown") {
    return sendJson(response, 400, { error: { message: "Unknown model namespace" } });
  }
  const baseUrl = selection.kind === "native" ? config.native.baseUrl : selection.route.baseUrl;
  const compactEndpoint = isCompactEndpoint(pathname);
  // DeepSeek has no /responses/compact endpoint; map it onto /v1/responses and
  // adapt the SSE into a single Codex compaction item after the call.
  const incomingUrl = new URL(request.url, "http://127.0.0.1");
  const chatWire = selection.kind === "external" && selection.route.wireApi === "chat";
  let targetUrl = selection.kind === "external"
    ? upstreamUrl(baseUrl, `${externalUpstreamPath(pathname, selection)}${incomingUrl.search}`)
    : upstreamUrl(baseUrl, request.url);
  const resolvedToken = selection.kind === "external" ? keychainToken(selection.route.auth) : undefined;
  if (selection.kind === "external" && selection.route.auth?.mode === "bearer_keychain" && !resolvedToken) {
    return sendJson(response, 503, {
      error: {
        message: `${selection.route.namespace} API credentials are not configured`,
        type: "credentials_missing",
      },
    });
  }
  const nativeCompaction = selection.kind === "native" && compactEndpoint;
  let compactionSecret = resolvedToken;
  if (!compactionSecret) {
    const needsLocalSecret = hasLocalCompaction(parsedBody?.input)
      || compactEndpoint;
    if (needsLocalSecret) {
      const compactionAuth = config.routes.find((route) => route.auth?.mode === "bearer_keychain")?.auth;
      compactionSecret = keychainToken(compactionAuth);
    }
  }
  let rewrittenBody;
  try {
    rewrittenBody = rewriteRequestBody(parsedBody, selection, {
      compactionSecret,
      compactEndpoint,
    });
  } catch (error) {
    return sendJson(response, error.statusCode ?? 400, {
      error: {
        message: error.message,
        type: "external_compaction_invalid",
      },
    });
  }
  const responsesTools = rewrittenBody?.tools;
  if (chatWire) {
    rewrittenBody = responsesToChatCompletions(rewrittenBody, {
      model: selection.upstreamModel,
      dialect: "ollama",
      keepAlive: selection.route.keepAlive,
    });
  }
  let adaptCompaction = isRemoteCompactionV2Request(parsedBody, selection, { compactEndpoint });
  const headers = forwardRequestHeaders(request.headers, selection, process.env, resolvedToken);
  headers.set("content-type", "application/json");
  let payload = JSON.stringify(rewrittenBody);

  // Local chat upstreams (Ollama) may take minutes of prompt evaluation before
  // the first byte. Open the SSE early and send keep-alive comments so the
  // client does not treat the silence as a dead connection and retry.
  let earlyTranslator;
  let keepAliveTimer;
  const stopKeepAlive = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
  };
  if (chatWire && !adaptCompaction && parsedBody?.stream !== false) {
    earlyTranslator = createChatToResponsesTranslator({
      id: `resp_${Date.now()}`,
      model: parsedBody.model,
    });
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    for (const event of earlyTranslator.start()) response.write(event);
    keepAliveTimer = setInterval(() => {
      if (response.destroyed) return stopKeepAlive();
      response.write(": keep-alive\n\n");
    }, 10_000);
    response.on("close", stopKeepAlive);
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(selection.route.timeoutMs ?? 300_000),
      redirect: "manual",
    });
  } catch (error) {
    const routeName = selection.kind === "native" ? "native" : selection.route.namespace;
    // Do not include bodies, credentials, or full upstream URLs in logs.
    const causeCode = typeof error?.cause?.code === "string" ? ` (${error.cause.code})` : "";
    console.error(`[router] ${routeName} upstream unavailable: ${error.name}${causeCode}`);
    stopKeepAlive();
    if (earlyTranslator) {
      response.write(`event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: { status: "failed", error: { message: `${routeName} model upstream is unavailable` } },
      })}\n\n`);
      return response.end();
    }
    return sendJson(response, 502, {
      error: { message: `${routeName} model upstream is unavailable`, type: "upstream_unavailable" },
    });
  }
  if (nativeCompaction && upstream.status === 404) {
    await upstream.arrayBuffer();
    targetUrl = upstreamUrl(baseUrl, `/v1/responses${incomingUrl.search}`);
    rewrittenBody = rewriteRequestBody(parsedBody, selection, {
      compactionSecret,
      nativeCompactionFallback: true,
    });
    payload = JSON.stringify(rewrittenBody);
    adaptCompaction = true;
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(selection.route.timeoutMs ?? 300_000),
      redirect: "manual",
    });
  }
  stopKeepAlive();
  if (earlyTranslator && !upstream.ok) {
    let upstreamMessage = "";
    try {
      const errorBody = await upstream.json();
      upstreamMessage = errorBody?.error?.message ?? "";
    } catch {}
    response.write(`event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: { message: upstreamMessage || `qwen upstream returned HTTP ${upstream.status}` },
      },
    })}\n\n`);
    return response.end();
  }

  if (adaptCompaction && upstream.ok) {
    try {
      let upstreamPayload = await (chatWire && upstream.body
        ? text(Readable.fromWeb(upstream.body).pipe(createChatToResponsesTransform({
          id: `resp_compact_${Date.now()}`,
          model: parsedBody.model,
        })))
        : upstream.text());
      const adapted = adaptCompactionSse(upstreamPayload, compactionSecret);
      const responseHeaders = forwardResponseHeaders(upstream.headers);
      delete responseHeaders["content-length"];
      responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
      response.writeHead(upstream.status, responseHeaders);
      return response.end(adapted);
    } catch (error) {
      console.error(`[router] external compaction adaptation failed: ${error.name}`);
      return sendJson(response, 502, {
        error: {
          message: "DeepSeek returned an invalid compaction response",
          type: "external_compaction_failed",
        },
      });
    }
  }

  const isEventStream = upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
  if (chatWire && upstream.ok && !isEventStream) {
    const mapped = chatCompletionsToResponses(await upstream.json(), {
      requestModel: parsedBody.model,
    });
    return sendJson(response, 200, mapped);
  }

  const translateChat = chatWire && upstream.ok;
  if (!earlyTranslator) {
    const responseHeaders = forwardResponseHeaders(upstream.headers);
    if (translateChat) {
      delete responseHeaders["content-length"];
      responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    }
    response.writeHead(upstream.status, responseHeaders);
  }
  if (!upstream.body) return response.end();
  const streams = [Readable.fromWeb(upstream.body)];
  if (translateChat) {
    streams.push(createChatToResponsesTransform({
      id: `resp_${Date.now()}`,
      model: parsedBody.model,
      translator: earlyTranslator,
    }));
  }
  if (selection.kind === "external" && selection.route.suppressReasoningContent && (isEventStream || translateChat)) {
    streams.push(createReasoningContentFilter({
      stabilizeMessagePhase: selection.route.stabilizeMessagePhase
        && Array.isArray(responsesTools)
        && responsesTools.length > 0,
    }));
  }
  streams.push(response);
  try {
    await pipeline(...streams);
  } catch (error) {
    if (response.destroyed || error.code === "ERR_STREAM_PREMATURE_CLOSE") return;
    const routeName = selection.kind === "native" ? "native" : selection.route.namespace;
    console.error(`[router] ${routeName} upstream stream failed: ${error.name}`);
    response.destroy();
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, {
        ok: true,
        provider: "openai",
        routes: (config.routes ?? []).map((route) => route.namespace),
      });
    }
    if (request.method === "GET" && /^\/v1\/models\/?$/.test(url.pathname)) {
      const data = (config.routes ?? []).flatMap((route) =>
        (route.models ?? []).map((model) => ({
          id: `${route.namespace}/${model.id}`,
          object: "model",
          owned_by: route.namespace,
        })),
      );
      return sendJson(response, 200, { object: "list", data });
    }
    const proxyPath = /^\/(?:v1\/)?(?:responses(?:\/compact)?|images\/(?:generations|edits))$/;
    if (request.method === "POST" && proxyPath.test(url.pathname)) {
      return await handleProxy(request, response, url.pathname);
    }
    return sendJson(response, 404, { error: { message: "Route not found" } });
  } catch (error) {
    console.error(`[router] request failed: ${error.name}`);
    return sendJson(response, error.statusCode ?? 500, { error: { message: "Router request failed" } });
  }
});

server.on("upgrade", (_request, socket) => {
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
});

// Local Ollama models can take far longer than Node's 5-minute default
// requestTimeout to produce a first token (cold model load, long prompts on
// modest hardware). Disable it so slow-but-alive SSE streams are not killed
// mid-response, which otherwise looks like an empty/blank reply to the
// client. headersTimeout stays at its default since headers arrive quickly.
server.requestTimeout = 0;

server.listen(config.listen.port, config.listen.host, () => {
  console.log(`[router] listening on http://${config.listen.host}:${config.listen.port}`);
});

function shutdown(signal) {
  console.log(`[router] received ${signal}`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
