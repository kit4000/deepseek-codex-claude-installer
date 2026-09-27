import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function managedNodePath(home) {
  return join(home, ".local/claude-hybrid-node/node/bin/node");
}

export function launchNodeCandidates(home, execPath = process.execPath) {
  return [
    managedNodePath(home),
    "/opt/homebrew/bin/node",
    execPath,
  ];
}

function defaultProbe(nodePath) {
  if (!nodePath || !existsSync(nodePath)) return false;
  const result = spawnSync(nodePath, ["-e", "process.exit(0)"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0;
}

export function resolveLaunchNode({
  home,
  execPath = process.execPath,
  probe = defaultProbe,
} = {}) {
  if (!home) throw new Error("HOME is required to resolve the Hybrid router Node");
  for (const candidate of launchNodeCandidates(home, execPath)) {
    if (probe(candidate)) return candidate;
  }
  throw new Error("No runnable Node binary for the Claude Hybrid router. An Intel Homebrew Node cannot start on Apple Silicon.");
}
