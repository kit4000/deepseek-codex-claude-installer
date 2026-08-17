import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_AGENT_MARKER,
  renderClaudeHybridAgents,
} from "../src/claude-agents.mjs";

const config = {
  models: {
    external: [
      { id: "deepseek-v4-pro[1m]", target: "deepseek-v4-pro[1m]", displayName: "DeepSeek V4 Pro (1M)" },
      { id: "deepseek-v4-flash", target: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
      { id: "gpt-5.6-sol", target: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { id: "gpt-5.6-luna", target: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
    ],
  },
};

test("renders four named Claude Code agents without changing global subagent defaults", () => {
  const agents = renderClaudeHybridAgents(config);
  assert.deepEqual(agents.map((entry) => entry.name), [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "gpt-5-6-sol",
    "gpt-5-6-luna",
  ]);
  assert.deepEqual(agents.map((entry) => entry.model), [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
  ]);
  for (const agent of agents) {
    assert.match(agent.contents, new RegExp(`^---\\nname: ${agent.name}\\n`));
    assert.ok(agent.contents.includes(`model: ${JSON.stringify(agent.model)}`));
    assert.match(agent.contents, new RegExp(CLAUDE_AGENT_MARKER));
    assert.doesNotMatch(agent.contents, /CLAUDE_CODE_SUBAGENT_MODEL|default_subagent/);
    assert.doesNotMatch(agent.contents, /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/);
  }
});
