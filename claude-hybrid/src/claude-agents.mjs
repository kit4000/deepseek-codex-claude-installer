export const CLAUDE_AGENT_MARKER = "<!-- Managed by claude-hybrid. -->";

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

export function agentFileName(entry) {
  if (typeof entry?.agentName === "string" && entry.agentName.length > 0) return `${entry.agentName}.md`;
  const fromId = String(entry?.id ?? "model")
    .replaceAll("[1m]", "")
    .replaceAll(".", "-")
    .replaceAll(/[^a-zA-Z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `${fromId}.md`;
}

export function agentName(entry) {
  return agentFileName(entry).replace(/\.md$/, "");
}

export function renderClaudeHybridAgent(entry) {
  const name = agentName(entry);
  const model = entry.target ?? entry.id;
  const description = [
    `${entry.displayName} via Claude Hybrid.`,
    "Use when the user explicitly asks for this model as a subagent.",
    "Billable external API usage.",
  ].join(" ");
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    `model: ${yamlQuote(model)}`,
    "---",
    CLAUDE_AGENT_MARKER,
    "",
    `You are a ${entry.displayName} subagent reached through Claude Hybrid's local router.`,
    "",
    "- Complete the bounded task assigned by the parent and return concise evidence.",
    "- You are not alone in the codebase. Preserve unrelated and concurrent edits.",
    "- Never read, print, copy, or request API keys. Authentication stays in macOS Keychain.",
    "- Do not perform destructive actions, publication, or extra billable work without authorization.",
    "",
  ].join("\n");
}

export function renderClaudeHybridAgents(config) {
  return (config?.models?.external ?? []).map((entry) => ({
    fileName: agentFileName(entry),
    name: agentName(entry),
    model: entry.target ?? entry.id,
    contents: renderClaudeHybridAgent(entry),
  }));
}
