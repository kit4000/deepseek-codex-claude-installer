import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  buildCursorCliInvocation,
  cursorCliChildEnv,
  parseCursorCliArgs,
  parseCursorCliAuth,
  resolveCursorAgentBin,
} from "../src/cursor-cli.mjs";

const usage = `Usage:
  cursor-cli-delegate --model grok-4-6|composer-2-5 [--workspace PATH] [--mode ask|plan] [--] PROMPT...
  cursor-cli-delegate --check-auth
  cursor-cli-delegate --dry-run --model grok-4-6 -- PROMPT...

Runs the logged-in Cursor CLI so Grok 4.6 and Composer 2.5 bill to the Cursor
subscription. Do not set CURSOR_API_KEY unless you intentionally want API billing.
`;

const parsed = parseCursorCliArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(usage);
  process.exit(0);
}

const home = process.env.HOME ?? homedir();
const agentBin = resolveCursorAgentBin({ env: process.env, home });
const env = cursorCliChildEnv(process.env, { allowApiKey: parsed.allowApiKey });

function runAgent(args, options = {}) {
  const result = spawnSync(agentBin, args, {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

if (parsed.checkAuth) {
  const status = runAgent(["status", "--format", "json"], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  if (status.status !== 0) {
    throw new Error(status.stderr.trim() || status.stdout.trim() || "Cursor CLI status failed");
  }
  const auth = parseCursorCliAuth(status.stdout);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    authenticated: true,
    email: auth.email,
    agentBin,
  }, null, 2)}\n`);
  process.exit(0);
}

if (!parsed.model) throw new Error("Pass --model grok-4-6 or --model composer-2-5");
const invocation = buildCursorCliInvocation({
  agentBin,
  model: parsed.model,
  prompt: parsed.prompt,
  workspace: parsed.workspace,
  mode: parsed.mode,
});

if (parsed.dryRun) {
  process.stdout.write(`${JSON.stringify({
    bin: invocation.bin,
    argv: invocation.argv,
    model: invocation.model.model,
    displayName: invocation.model.displayName,
    workspace: parsed.workspace,
    apiKeyPresent: Boolean(env.CURSOR_API_KEY),
  }, null, 2)}\n`);
  process.exit(0);
}

const status = runAgent(["status", "--format", "json"], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
if (status.status !== 0) {
  throw new Error(status.stderr.trim() || status.stdout.trim() || "Cursor CLI status failed");
}
parseCursorCliAuth(status.stdout);

const child = runAgent(invocation.argv, {
  cwd: parsed.workspace,
  stdio: "inherit",
});
process.exit(child.status ?? 1);
