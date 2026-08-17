import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  buildCodexCliInvocation,
  codexCliChildEnv,
  codexLoginStatusText,
  parseCodexCliArgs,
  parseCodexLoginStatus,
  resolveCodexBin,
} from "../src/codex-cli.mjs";

const usage = `Usage:
  codex-cli-delegate --model gpt-5-6-sol|gpt-5-6-luna [--workspace PATH] [--] PROMPT...
  codex-cli-delegate --check-auth
  codex-cli-delegate --dry-run --model gpt-5-6-sol -- PROMPT...

Runs the logged-in Codex CLI so GPT-5.6 Sol and Luna bill to the ChatGPT
subscription. Do not set OPENAI_API_KEY unless you intentionally want API billing.
`;

const parsed = parseCodexCliArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(usage);
  process.exit(0);
}

const home = process.env.HOME ?? homedir();
const codexBin = resolveCodexBin({ env: process.env, home });
const env = codexCliChildEnv(process.env, { allowApiKey: parsed.allowApiKey });

function runCodex(args, options = {}) {
  const result = spawnSync(codexBin, args, {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

if (parsed.checkAuth) {
  const status = runCodex(["login", "status"], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  if (status.status !== 0) {
    throw new Error(codexLoginStatusText(status).trim() || "Codex login status failed");
  }
  const auth = parseCodexLoginStatus(codexLoginStatusText(status));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    authenticated: true,
    method: auth.method,
    codexBin,
  }, null, 2)}\n`);
  process.exit(0);
}

if (!parsed.model) throw new Error("Pass --model gpt-5-6-sol or --model gpt-5-6-luna");
const invocation = buildCodexCliInvocation({
  codexBin,
  model: parsed.model,
  prompt: parsed.prompt,
  workspace: parsed.workspace,
  sandbox: parsed.sandbox,
});

if (parsed.dryRun) {
  process.stdout.write(`${JSON.stringify({
    bin: invocation.bin,
    argv: invocation.argv,
    model: invocation.model.model,
    displayName: invocation.model.displayName,
    workspace: parsed.workspace,
    apiKeyPresent: Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY),
  }, null, 2)}\n`);
  process.exit(0);
}

const status = runCodex(["login", "status"], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
if (status.status !== 0) {
  throw new Error(codexLoginStatusText(status).trim() || "Codex login status failed");
}
parseCodexLoginStatus(codexLoginStatusText(status));

const child = runCodex(invocation.argv, {
  cwd: parsed.workspace,
  stdio: "inherit",
});
process.exit(child.status ?? 1);
