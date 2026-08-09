import { readFile } from "node:fs/promises";

const model = process.argv[2];
const reasoningEffort = process.argv[3];
if (!model) throw new Error("Usage: node scripts/smoke.mjs <model> [reasoning-effort]");

const headers = {
  "content-type": "application/json",
  accept: "text/event-stream",
  originator: "codex_cli_rs",
};

if (!model.includes("/")) {
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  const auth = JSON.parse(await readFile(`${codexHome}/auth.json`, "utf8"));
  if (!auth.tokens?.access_token) throw new Error("Codex ChatGPT access token is unavailable");
  headers.authorization = `Bearer ${auth.tokens.access_token}`;
  if (auth.tokens.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;
}

const response = await fetch("http://127.0.0.1:10100/v1/responses", {
  method: "POST",
  headers,
  body: JSON.stringify({
    model,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with only ROUTER_OK" }],
    }],
    tools: [],
    store: false,
    stream: true,
  }),
  signal: AbortSignal.timeout(120_000),
});

const body = await response.text();
if (!response.ok) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message ?? parsed.message ?? `HTTP ${response.status}`;
  } catch {}
  console.log(JSON.stringify({ model, reasoningEffort, status: response.status, completed: false, error: message.slice(0, 500) }));
  process.exitCode = 1;
} else {
  let output = "";
  let completed = false;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_text.delta") output += event.delta ?? "";
      if (event.type === "response.completed") completed = true;
    } catch {}
  }
  console.log(JSON.stringify({ model, reasoningEffort, status: response.status, completed, output }));
  if (!completed || output.trim() !== "ROUTER_OK") process.exitCode = 1;
}
