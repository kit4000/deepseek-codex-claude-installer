import assert from "node:assert/strict";
import test from "node:test";
import { managedNodePath, resolveLaunchNode } from "../src/host-node.mjs";

test("prefers the managed Apple Silicon Node over the process that launched the installer", () => {
  const home = "/Users/macbookprok";
  const managed = managedNodePath(home);
  const chosen = resolveLaunchNode({
    home,
    execPath: "/usr/local/Cellar/node@22/22.23.1/bin/node",
    probe: (candidate) => candidate === managed,
  });
  assert.equal(chosen, "/Users/macbookprok/.local/claude-hybrid-node/node/bin/node");
});

test("skips a Node binary that cannot run and uses the next runnable one", () => {
  const home = "/Users/macbookprok";
  const chosen = resolveLaunchNode({
    home,
    execPath: "/opt/homebrew/bin/node",
    probe: (candidate) => candidate === "/opt/homebrew/bin/node",
  });
  assert.equal(chosen, "/opt/homebrew/bin/node");
});

test("refuses to point the LaunchAgent at a Node that cannot execute", () => {
  assert.throws(
    () => resolveLaunchNode({
      home: "/Users/macbookprok",
      execPath: "/usr/local/Cellar/node@22/22.23.1/bin/node",
      probe: () => false,
    }),
    /cannot start on Apple Silicon/,
  );
});
