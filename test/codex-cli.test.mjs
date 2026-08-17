import assert from "node:assert/strict";
import test from "node:test";
import {
  boundCodexCliPrompt,
  buildCodexCliInvocation,
  canReplaceHybridApiAgent,
  codexCliChildEnv,
  parseCodexCliArgs,
  parseCodexLoginStatus,
  codexLoginStatusText,
  renderCodexCliClaudeAgents,
  renderCodexCliClaudeCommands,
  renderCodexCliDelegateWrapper,
  renderCodexCliModelWrapper,
  resolveCodexBin,
  resolveCodexCliModel,
} from "../src/codex-cli.mjs";
import { EXTENSION_MARKER, SKILL_MARKER } from "../src/extensions.mjs";

test("resolves GPT-5.6 Sol and Luna onto ChatGPT Codex model slugs", () => {
  assert.equal(resolveCodexCliModel("gpt-5-6-sol").model, "gpt-5.6-sol");
  assert.equal(resolveCodexCliModel("gpt-5.6-sol").displayName, "GPT-5.6 Sol");
  assert.equal(resolveCodexCliModel("sol").commandName, "gpt-5-6-sol");
  assert.equal(resolveCodexCliModel("gpt-5-6-luna").model, "gpt-5.6-luna");
  assert.equal(resolveCodexCliModel("luna").agentName, "gpt-5-6-luna");
  assert.throws(() => resolveCodexCliModel("cursor-grok-4.6-high-fast"), /Unsupported Codex CLI model/);
  assert.throws(() => resolveCodexCliModel(""), /required/);
});

test("builds a headless Codex exec invocation on the ChatGPT subscription path", () => {
  const invocation = buildCodexCliInvocation({
    codexBin: "/tmp/codex",
    model: "gpt-5-6-sol",
    prompt: "fix the failing test in src/foo.mjs",
    workspace: "/tmp/workspace",
  });
  assert.equal(invocation.bin, "/tmp/codex");
  assert.equal(invocation.model.model, "gpt-5.6-sol");
  assert.deepEqual(invocation.argv.slice(0, 12), [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    "-s",
    "workspace-write",
    "-m",
    "gpt-5.6-sol",
  ]);
  assert.equal(invocation.argv.at(-1), boundCodexCliPrompt("fix the failing test in src/foo.mjs"));
  assert.ok(!invocation.argv.includes("--with-api-key"));
  assert.ok(!invocation.argv.includes("OPENAI_API_KEY"));
  assert.match(invocation.argv.at(-1), /ChatGPT subscription/);
  assert.throws(
    () => buildCodexCliInvocation({ codexBin: "/tmp/codex", model: "gpt-5-6-luna", prompt: "   " }),
    /non-empty prompt/,
  );
});

test("strips OpenAI API keys so billing stays on the logged-in ChatGPT subscription", () => {
  const env = codexCliChildEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "secret-should-not-be-used",
    CODEX_API_KEY: "also-secret",
    HOME: "/tmp",
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  const allowed = codexCliChildEnv({ OPENAI_API_KEY: "kept" }, { allowApiKey: true });
  assert.equal(allowed.OPENAI_API_KEY, "kept");
});

test("parses Codex ChatGPT login status without exposing tokens", () => {
  const authed = parseCodexLoginStatus("Logged in using ChatGPT\n");
  assert.equal(authed.isAuthenticated, true);
  assert.equal(authed.method, "chatgpt");
  assert.equal("accessToken" in authed, false);
  assert.throws(() => parseCodexLoginStatus("Logged in using an API key"), /API key/);
  assert.throws(
    () => parseCodexLoginStatus("Logged in using ChatGPT\nLogged in using an API key"),
    /API key/,
  );
  assert.throws(() => parseCodexLoginStatus(""), /codex login/);
  assert.throws(() => parseCodexLoginStatus("Not logged in"), /codex login/);
  assert.match(
    parseCodexLoginStatus(codexLoginStatusText({
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    })).method,
    /chatgpt/,
  );
});

test("finds the Codex binary from explicit path, home, or PATH", () => {
  const existing = new Set(["/custom/codex", "/Users/test/.local/bin/codex"]);
  assert.equal(
    resolveCodexBin({
      env: { CODEX_BIN: "/custom/codex" },
      home: "/Users/test",
      exists: (path) => existing.has(path),
    }),
    "/custom/codex",
  );
  assert.equal(
    resolveCodexBin({
      env: { PATH: "/opt/bin:/usr/bin" },
      home: "/Users/test",
      exists: (path) => existing.has(path),
    }),
    "/Users/test/.local/bin/codex",
  );
  assert.throws(
    () => resolveCodexBin({
      env: { PATH: "/opt/bin" },
      home: "/Users/missing",
      exists: () => false,
    }),
    /Codex CLI/,
  );
});

test("parses wrapper argv so model flags stay outside the prompt", () => {
  const parsed = parseCodexCliArgs([
    "--model",
    "gpt-5-6-luna",
    "--workspace",
    "/tmp/ws",
    "--dry-run",
    "--",
    "implement the bounded task",
  ]);
  assert.equal(parsed.model, "gpt-5-6-luna");
  assert.equal(parsed.workspace, "/tmp/ws");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.prompt, "implement the bounded task");
});

test("renders managed wrappers and Claude Code slash commands that shell out to Codex", () => {
  const delegate = renderCodexCliDelegateWrapper("/path with space/node", "/bundle/codex-cli's delegate.mjs");
  assert.match(delegate, new RegExp(EXTENSION_MARKER));
  assert.match(delegate, /exec '\/path with space\/node'/);
  assert.match(delegate, /'\/bundle\/codex-cli'\\''s delegate\.mjs'/);

  const sol = renderCodexCliModelWrapper("/usr/bin/node", "/bundle/codex-cli-delegate.mjs", "gpt-5-6-sol");
  assert.match(sol, /--model gpt-5-6-sol/);

  const agents = renderCodexCliClaudeAgents();
  assert.deepEqual(agents.map((entry) => entry.name).sort(), [
    "gpt-5-6-luna",
    "gpt-5-6-sol",
  ]);
  for (const agent of agents) {
    assert.match(agent.contents, new RegExp(SKILL_MARKER));
    assert.match(agent.contents, /ASSIGNED_TASK_TEXT/);
    assert.doesNotMatch(agent.contents, /-- "\$TASK"/);
    assert.doesNotMatch(agent.contents, /-- "\$ARGUMENTS"/);
    assert.match(agent.contents, /ChatGPT subscription/);
    assert.doesNotMatch(agent.contents, /^model:/m);
    assert.doesNotMatch(agent.contents, /Claude Hybrid/);
    assert.doesNotMatch(agent.contents, /OPENAI_API_KEY=/);
    assert.doesNotMatch(agent.contents, /CLAUDE_CODE_SUBAGENT_MODEL|default_subagent/);
  }

  const commands = renderCodexCliClaudeCommands();
  assert.deepEqual(commands.map((entry) => entry.name).sort(), [
    "gpt-5-6-luna",
    "gpt-5-6-sol",
  ]);
  for (const command of commands) {
    assert.match(command.contents, new RegExp(SKILL_MARKER));
    assert.match(command.contents, /\$HOME\/\.local\/bin\/gpt-5-6-/);
    assert.match(command.contents, /\$ARGUMENTS/);
  }

  assert.equal(canReplaceHybridApiAgent(`---
name: gpt-5-6-sol
model: "gpt-5.6-sol"
---
<!-- Managed by claude-hybrid. -->
You are a GPT-5.6 Sol subagent reached through Claude Hybrid's local router.
`), true);
  assert.equal(canReplaceHybridApiAgent("unmanaged custom agent"), false);
});
