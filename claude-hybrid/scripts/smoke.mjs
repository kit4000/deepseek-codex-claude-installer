import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.slice(2).includes("--allow-billing")) {
  throw new Error("Billing smoke tests are disabled by default. Obtain explicit user approval, then rerun with --allow-billing.");
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME;
const configPath = process.env.CLAUDE_HYBRID_CONFIG ?? resolve(projectRoot, "config/claude-hybrid.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const expand = (value) => String(value).replaceAll("<home>", home);
const routerBase = `http://127.0.0.1:${config.router.port}`;
const flashAlias = config.models.external.find((entry) => entry.target === "deepseek-v4-flash")?.aliases?.[0];

if (!flashAlias) throw new Error("DeepSeek Flash alias is not configured");

const report = { ok: true, checks: {} };

async function check(name, fn) {
  try {
    report.checks[name] = await fn();
  } catch (error) {
    report.checks[name] = { ok: false, error: { name: error?.name, message: error?.message } };
  }
  if (report.checks[name].ok !== true) report.ok = false;
}

await check("health", async () => {
  const response = await fetch(`${routerBase}/healthz`, { signal: AbortSignal.timeout(2000) });
  return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : undefined };
});

await check("modelList", async () => {
  const response = await fetch(`${routerBase}/v1/models`, { signal: AbortSignal.timeout(5000) });
  const body = response.ok ? await response.json() : { data: [] };
  const externalIds = config.models.external.map((entry) => entry.id);
  return {
    ok: response.ok && externalIds.every((id) => body.data?.some((entry) => entry.id === id)),
    ids: body.data?.map((entry) => entry.id) ?? [],
  };
});

await check("nativeRoute", async () => {
  const response = await fetch(`${routerBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer claude-hybrid-local-smoke-invalid",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return {
    ok: response.status === 401 || response.status === 403 || response.status === 429,
    status: response.status,
    body: (await response.text()).slice(0, 500),
  };
});

await check("deepseekRoute", async () => {
  const response = await fetch(`${routerBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer native-oauth-placeholder",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: flashAlias,
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with only DEEPSEEK_HYBRID_OK" }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return {
    ok: response.ok && text.includes(`"text":"DEEPSEEK_HYBRID_OK"`),
    status: response.status,
    body: text.slice(0, 800),
  };
});

await check("countTokens", async () => {
  const response = await fetch(`${routerBase}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: flashAlias,
      messages: [{ role: "user", content: "hello" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.ok ? await response.json() : undefined;
  return { ok: response.ok && typeof body?.input_tokens === "number", status: response.status, body };
});

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
