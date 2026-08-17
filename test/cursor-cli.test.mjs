import assert from "node:assert/strict";
import test from "node:test";
import {
  boundCursorCliPrompt,
  buildCursorCliInvocation,
  cursorCliChildEnv,
  parseCursorCliArgs,
  parseCursorCliAuth,
  renderCursorCliClaudeAgents,
  renderCursorCliClaudeCommands,
  renderCursorCliDelegateWrapper,
  renderCursorCliModelWrapper,
  resolveCursorAgentBin,
  resolveCursorCliModel,
} from "../src/cursor-cli.mjs";
import { EXTENSION_MARKER, SKILL_MARKER } from "../src/extensions.mjs";

test("resolves Grok 4.6 and Composer 2.5 onto Cursor subscription model slugs", () => {
  assert.equal(resolveCursorCliModel("grok-4-6").model, "cursor-grok-4.6-high-fast");
  assert.equal(resolveCursorCliModel("Grok").displayName, "Cursor Grok 4.6");
  assert.equal(resolveCursorCliModel("cursor-grok-4.6-high-fast").alias, "grok-4-6");
  assert.equal(resolveCursorCliModel("composer-2-5").model, "composer-2.5-fast");
  assert.equal(resolveCursorCliModel("composer-2.5").displayName, "Composer 2.5");
  assert.equal(resolveCursorCliModel("composer-2.5-fast").commandName, "cursor-composer-2-5");
  assert.throws(() => resolveCursorCliModel("gpt-5.6-sol"), /Unsupported Cursor CLI model/);
  assert.throws(() => resolveCursorCliModel(""), /required/);
});

test("builds a headless Cursor CLI invocation without API-key flags", () => {
  const invocation = buildCursorCliInvocation({
    agentBin: "/tmp/agent",
    model: "grok-4-6",
    prompt: "fix the failing test in src/foo.mjs",
    workspace: "/tmp/workspace",
  });
  assert.equal(invocation.bin, "/tmp/agent");
  assert.equal(invocation.model.model, "cursor-grok-4.6-high-fast");
  assert.deepEqual(invocation.argv.slice(0, 10), [
    "-p",
    "--output-format",
    "text",
    "--model",
    "cursor-grok-4.6-high-fast",
    "--trust",
    "--force",
    "--workspace",
    "/tmp/workspace",
    "--",
  ]);
  assert.equal(invocation.argv.at(-1), boundCursorCliPrompt("fix the failing test in src/foo.mjs"));
  assert.ok(!invocation.argv.includes("--api-key"));
  assert.ok(!invocation.argv.includes("CURSOR_API_KEY"));
  assert.match(invocation.argv.at(-1), /Cursor subscription/);
  assert.match(invocation.argv.at(-1), /Never read, print, copy, or request API keys/);
  assert.throws(
    () => buildCursorCliInvocation({ agentBin: "/tmp/agent", model: "composer-2-5", prompt: "   " }),
    /non-empty prompt/,
  );
});

test("ask mode stays read-oriented and still uses the subscription model", () => {
  const invocation = buildCursorCliInvocation({
    agentBin: "/tmp/agent",
    model: "composer-2-5",
    prompt: "summarize src/cursor-cli.mjs",
    mode: "ask",
  });
  assert.equal(invocation.argv[4], "composer-2.5-fast");
  assert.ok(invocation.argv.includes("--mode"));
  assert.equal(invocation.argv[invocation.argv.indexOf("--mode") + 1], "ask");
  assert.throws(
    () => buildCursorCliInvocation({ agentBin: "/tmp/agent", model: "grok-4-6", prompt: "x", mode: "yolo" }),
    /Unsupported Cursor CLI mode/,
  );
});

test("strips CURSOR_API_KEY so billing stays on the logged-in Cursor subscription", () => {
  const env = cursorCliChildEnv({
    PATH: "/usr/bin",
    CURSOR_API_KEY: "secret-should-not-be-used",
    HOME: "/tmp",
  });
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  const allowed = cursorCliChildEnv({ CURSOR_API_KEY: "kept" }, { allowApiKey: true });
  assert.equal(allowed.CURSOR_API_KEY, "kept");
});

test("parses Cursor CLI auth without exposing tokens", () => {
  const authed = parseCursorCliAuth(JSON.stringify({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    userInfo: { email: "staff@example.com" },
    accessToken: "must-not-be-copied",
  }));
  assert.equal(authed.isAuthenticated, true);
  assert.equal(authed.email, "staff@example.com");
  assert.equal("accessToken" in authed, false);
  assert.throws(() => parseCursorCliAuth(JSON.stringify({ isAuthenticated: false })), /agent login/);
  assert.throws(() => parseCursorCliAuth(""), /agent login/);
});

test("finds the Cursor agent binary from explicit path, home, or PATH", () => {
  const existing = new Set(["/custom/agent", "/Users/test/.local/bin/agent"]);
  assert.equal(
    resolveCursorAgentBin({
      env: { CURSOR_AGENT_BIN: "/custom/agent" },
      home: "/Users/test",
      exists: (path) => existing.has(path),
    }),
    "/custom/agent",
  );
  assert.equal(
    resolveCursorAgentBin({
      env: { PATH: "/opt/bin:/usr/bin" },
      home: "/Users/test",
      exists: (path) => existing.has(path),
    }),
    "/Users/test/.local/bin/agent",
  );
  assert.throws(
    () => resolveCursorAgentBin({
      env: { PATH: "/opt/bin" },
      home: "/Users/missing",
      exists: () => false,
    }),
    /Cursor CLI/,
  );
});

test("parses wrapper argv so model flags stay outside the prompt", () => {
  const parsed = parseCursorCliArgs([
    "--model",
    "composer-2-5",
    "--workspace",
    "/tmp/ws",
    "--mode",
    "plan",
    "--dry-run",
    "--",
    "implement the bounded task",
  ]);
  assert.equal(parsed.model, "composer-2-5");
  assert.equal(parsed.workspace, "/tmp/ws");
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.prompt, "implement the bounded task");
});

test("renders managed wrappers and Claude Code agents that shell out to Cursor CLI", () => {
  const delegate = renderCursorCliDelegateWrapper("/path with space/node", "/bundle/cursor-cli's delegate.mjs");
  assert.match(delegate, new RegExp(EXTENSION_MARKER));
  assert.match(delegate, /exec '\/path with space\/node'/);
  assert.match(delegate, /'\/bundle\/cursor-cli'\\''s delegate\.mjs'/);
  assert.match(delegate, /"\$@"/);

  const grok = renderCursorCliModelWrapper("/usr/bin/node", "/bundle/cursor-cli-delegate.mjs", "grok-4-6");
  assert.match(grok, /--model grok-4-6/);
  assert.match(grok, /"\$@"/);

  const agents = renderCursorCliClaudeAgents();
  assert.deepEqual(agents.map((entry) => entry.name).sort(), [
    "cursor-composer-2-5",
    "cursor-grok-4-6",
  ]);
  for (const agent of agents) {
    assert.match(agent.contents, new RegExp(SKILL_MARKER));
    assert.match(agent.contents, /\$HOME\/\.local\/bin\/cursor-cli-delegate/);
    assert.match(agent.contents, /\$HOME\/\.local\/bin\/cursor-grok-4-6|\$HOME\/\.local\/bin\/cursor-composer-2-5/);
    assert.match(agent.contents, /Cursor subscription/);
    assert.doesNotMatch(agent.contents, /^model:/m);
    assert.doesNotMatch(agent.contents, /ANTHROPIC_DEFAULT_/);
    assert.doesNotMatch(agent.contents, /CURSOR_API_KEY=/);
    assert.doesNotMatch(agent.contents, /CLAUDE_CODE_SUBAGENT_MODEL|default_subagent/);
    assert.doesNotMatch(agent.contents, /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/);
  }

  const commands = renderCursorCliClaudeCommands();
  assert.deepEqual(commands.map((entry) => entry.name).sort(), [
    "cursor-composer-2-5",
    "cursor-grok-4-6",
  ]);
  for (const command of commands) {
    assert.match(command.contents, new RegExp(SKILL_MARKER));
    assert.match(command.contents, /\$HOME\/\.local\/bin\/cursor-/);
    assert.match(command.contents, /\$ARGUMENTS/);
  }
});
