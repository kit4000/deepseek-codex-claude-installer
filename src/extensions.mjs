export const EXTENSION_MARKER = "# Managed by deepseek-codex-claude-installer.";
export const SKILL_MARKER = "<!-- Managed by deepseek-codex-claude-installer. -->";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function setTableKey(source, tableName, key, value) {
  const lines = source.split(/\r?\n/);
  const tableHeader = `[${tableName}]`;
  const tableStart = lines.findIndex((line) => line.trim() === tableHeader);
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  if (tableStart === -1) {
    while (lines.at(-1) === "") lines.pop();
    lines.push("", tableHeader, `${key} = ${value}`, "");
    return lines.join("\n");
  }
  let tableEnd = lines.length;
  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      tableEnd = index;
      break;
    }
  }
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(tableStart + 1, 0, `${key} = ${value}`);
  return lines.join("\n");
}

export function renderDeepSeekAgentProfile() {
  return `${EXTENSION_MARKER}
model = "deepseek/deepseek-v4-flash"
model_provider = "openai"
model_reasoning_effort = "max"
developer_instructions = """
You are a DeepSeek V4 external-API subagent. Complete the bounded task assigned by the parent agent and return concise evidence.

- You are not alone in the codebase. Preserve unrelated and concurrent edits; never revert work you do not own.
- Inspect before editing, remain within the assigned files and responsibility, and report exact verification performed.
- Never read, print, copy, or request API keys. Authentication is supplied by the loopback router and macOS Keychain.
- Do not perform destructive actions, external publication, or billable follow-on work beyond the delegated task without explicit authorization.
"""
`;
}

export function patchDeepSeekAgentRegistration(source, profilePath) {
  const tableHeader = "[agents.deepseek-v4]";
  const lines = source.split(/\r?\n/);
  const tableStart = lines.findIndex((line) => line.trim() === tableHeader);
  if (tableStart !== -1) {
    if (tableStart === 0 || lines[tableStart - 1].trim() !== EXTENSION_MARKER) {
      throw new Error("Refusing to overwrite an unmanaged [agents.deepseek-v4] table");
    }
    let tableEnd = lines.length;
    for (let index = tableStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index])) {
        tableEnd = index;
        break;
      }
    }
    lines.splice(tableStart - 1, tableEnd - tableStart + 1);
  }
  while (lines.at(-1) === "") lines.pop();
  lines.push(
    "",
    EXTENSION_MARKER,
    tableHeader,
    'description = "DeepSeek V4 Flash external-API agent. It is available alongside the main model picker; use for explicitly requested or approved billable delegation."',
    `config_file = ${tomlString(profilePath)}`,
    "",
  );
  return setTableKey(lines.join("\n"), "features", "multi_agent", "true");
}

export function renderUpdaterWrapper(nodePath, updaterPath) {
  const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    EXTENSION_MARKER,
    `exec ${quote(nodePath)} ${quote(updaterPath)} "$@"`,
    "",
  ].join("\n");
}
