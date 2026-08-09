import assert from "node:assert/strict";
import test from "node:test";
import { decideClaudeHybridUpdate } from "../src/update-plan.mjs";

const baseline = {
  sourceApp: "/Users/test/Applications/Claude Official.app",
  targetApp: "/Applications/Claude.app",
  sourceVersion: "1.2.3",
  sourceBuild: "123",
  targetExists: true,
  targetVersion: "1.2.3",
  targetBuild: "123",
  installedPatchVersion: "patch-2",
  expectedPatchVersion: "patch-2",
  sourceSignatureValid: true,
  environmentAnchorPresent: true,
  labelAnchorPresent: true,
  credentialAvailable: true,
  claudeRunning: false,
  targetPatchCompatible: true,
};

test("reports an up-to-date Hybrid without applying changes", () => {
  assert.equal(decideClaudeHybridUpdate(baseline).status, "success");
  assert.match(decideClaudeHybridUpdate({ ...baseline, targetPatchCompatible: false }).summary, /rebuild is available/);
});

test("detects official app and installer patch updates", () => {
  assert.match(decideClaudeHybridUpdate({ ...baseline, sourceBuild: "124" }).summary, /rebuild is available/);
  const metadata = decideClaudeHybridUpdate({ ...baseline, expectedPatchVersion: "patch-3" });
  assert.match(metadata.summary, /metadata migration is available/);
  assert.equal(metadata.artifacts.updateKind, "metadata-migration");
  const rebuild = decideClaudeHybridUpdate({
    ...baseline,
    expectedPatchVersion: "patch-3",
    targetPatchCompatible: false,
  });
  assert.match(rebuild.summary, /rebuild is available/);
  assert.equal(rebuild.artifacts.updateKind, "rebuild");
});

test("stops safely when exact anchors changed", () => {
  const result = decideClaudeHybridUpdate({ ...baseline, labelAnchorPresent: false }, "apply");
  assert.equal(result.status, "error");
  assert.match(result.root_cause_hint, /fuzzy patching is intentionally disabled/);
});

test("requires apps to be closed and a per-user credential before apply", () => {
  assert.equal(decideClaudeHybridUpdate({ ...baseline, sourceBuild: "124", claudeRunning: true }, "apply").status, "warning");
  assert.equal(decideClaudeHybridUpdate({ ...baseline, sourceBuild: "124", credentialAvailable: false }, "apply").status, "error");
});
