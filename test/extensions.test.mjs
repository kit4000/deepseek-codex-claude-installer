import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTENSION_MARKER,
  patchDeepSeekAgentRegistration,
  renderDeepSeekAgentProfile,
  renderUpdaterWrapper,
} from "../src/extensions.mjs";

test("registers a DeepSeek subagent without changing the main model or defaults", () => {
  const source = `model = "gpt-5.6-sol"
model_provider = "openai"

[features]
multi_agent = false

[projects."/tmp/example"]
trust_level = "trusted"
`;
  const patched = patchDeepSeekAgentRegistration(source, "/Users/test/.codex/agent-profiles/deepseek-v4.toml");
  assert.match(patched, /model = "gpt-5\.6-sol"/);
  assert.match(patched, /multi_agent = true/);
  assert.match(patched, /\[agents\.deepseek-v4\]/);
  assert.match(patched, /config_file = "\/Users\/test\/\.codex\/agent-profiles\/deepseek-v4\.toml"/);
  assert.doesNotMatch(patched, /default_subagent_model|default_subagent_reasoning_effort/);
  assert.match(patched, /\[projects\."\/tmp\/example"\]/);
});

test("updates only a previously managed agent registration", () => {
  const managed = `${EXTENSION_MARKER}
[agents.deepseek-v4]
description = "old"
config_file = "/old"
`;
  assert.equal((patchDeepSeekAgentRegistration(managed, "/new").match(/\[agents\.deepseek-v4\]/g) ?? []).length, 1);
  assert.throws(
    () => patchDeepSeekAgentRegistration("[agents.deepseek-v4]\ndescription = \"user\"\n", "/new"),
    /unmanaged/,
  );
});

test("agent registration is idempotent", () => {
  const source = `model = "gpt-5.6-sol"

[features]
multi_agent = false
`;
  const once = patchDeepSeekAgentRegistration(source, "/Users/test/.codex/agent-profiles/deepseek-v4.toml");
  const twice = patchDeepSeekAgentRegistration(once, "/Users/test/.codex/agent-profiles/deepseek-v4.toml");
  assert.equal(twice, once);
});

test("agent profile routes only that child to DeepSeek V4 Flash max", () => {
  const profile = renderDeepSeekAgentProfile();
  assert.match(profile, /model = "deepseek\/deepseek-v4-flash"/);
  assert.match(profile, /model_provider = "openai"/);
  assert.match(profile, /model_reasoning_effort = "max"/);
  assert.doesNotMatch(profile, /openai_base_url|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/);
});

test("updater wrapper safely quotes absolute paths", () => {
  const wrapper = renderUpdaterWrapper("/path with space/node", "/bundle/update's script.mjs");
  assert.match(wrapper, /exec '\/path with space\/node'/);
  assert.match(wrapper, /'\/bundle\/update'\\''s script\.mjs'/);
  assert.match(wrapper, /"\$@"/);
});
