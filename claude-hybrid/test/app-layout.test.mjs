import assert from "node:assert/strict";
import test from "node:test";
import {
  decideClaudeAppLayout,
  renderPreferClaudeHybrid,
} from "../src/app-layout.mjs";
import {
  buildEnvironmentPatch,
  buildModelLabelPatch,
} from "../src/app-patch.mjs";

const baseline = {
  defaultLayout: true,
  sourceExists: true,
  sourceAppleSigned: true,
  targetExists: true,
  targetIsHybrid: true,
  targetAppleSigned: false,
  legacyExists: false,
  legacyIsHybrid: false,
};

test("keeps an existing pristine Official source and rebuilds the daily Hybrid", () => {
  assert.deepEqual(decideClaudeAppLayout(baseline), {
    actions: ["rebuild-hybrid"],
    warnings: [],
  });
});

test("moves a pristine /Applications app into Official before building Hybrid", () => {
  assert.deepEqual(decideClaudeAppLayout({
    ...baseline,
    targetIsHybrid: false,
    targetAppleSigned: true,
  }), {
    actions: ["backup-official", "move-target-to-official", "rebuild-hybrid"],
    warnings: [],
  });
});

test("refuses to treat an ad-hoc unmarked target as the pristine source", () => {
  assert.throws(
    () => decideClaudeAppLayout({
      ...baseline,
      sourceExists: false,
      targetIsHybrid: false,
      targetAppleSigned: false,
    }),
    /Apple-signed pristine Claude source/,
  );
});

test("rejects a damaged Official source before planning any legacy migration", () => {
  assert.throws(
    () => decideClaudeAppLayout({
      ...baseline,
      sourceAppleSigned: false,
      legacyExists: true,
      legacyIsHybrid: true,
    }),
    /Official source is not pristine and Apple-signed/,
  );
});

test("backs up a marked legacy Claude Hybrid app during migration", () => {
  assert.deepEqual(decideClaudeAppLayout({
    ...baseline,
    legacyExists: true,
    legacyIsHybrid: true,
  }), {
    actions: ["backup-legacy-hybrid", "rebuild-hybrid"],
    warnings: [],
  });
});

test("leaves an unmarked legacy app untouched and warns", () => {
  assert.deepEqual(decideClaudeAppLayout({
    ...baseline,
    legacyExists: true,
    legacyIsHybrid: false,
  }), {
    actions: ["rebuild-hybrid"],
    warnings: ["legacy-target-unmarked"],
  });
});

test("prefer helper unregisters Official and registers /Applications Hybrid", () => {
  const script = renderPreferClaudeHybrid();
  assert.match(script, /OFFICIAL="\$\{HOME\}\/Applications\/Claude Official\.app"/);
  assert.match(script, /HYBRID="\/Applications\/Claude\.app"/);
  assert.match(script, /"\$LSREGISTER" -u "\$OFFICIAL"/);
  assert.match(script, /"\$LSREGISTER" -f -R "\$HYBRID"/);
});

test("model label patch derives the WebContentsView variable from each exact anchor", () => {
  for (const variable of ["Y", "Z", "$view_1"]) {
    const from = `function make(){return ${variable}=new a.WebContentsView(e),t.c(${variable}.webContents,t.n.CLAUDE_AI_WEB),${variable}.webContents.setMaxListeners(20),${variable}}`;
    const patch = buildModelLabelPatch("/chunk.js", from);
    assert.match(patch.to, new RegExp(`${variable.replace("$", "\\$")}\\.webContents\\.on`));
    assert.ok(patch.to.endsWith(`,${variable}}`));
  }
});

test("model label patch rewrites only the DeepSeek slots and leaves native names alone", () => {
  const from = "function make(){return Z=new a.WebContentsView(e),t.c(Z.webContents,t.n.CLAUDE_AI_WEB),Z.webContents.setMaxListeners(20),Z}";
  const patch = buildModelLabelPatch("/chunk.js", from);
  assert.ok(patch.to.includes("Sonnet 4.6"));
  assert.ok(patch.to.includes("DeepSeek V4 Flash"));
  assert.ok(patch.to.includes("Opus 4.6"));
  assert.ok(patch.to.includes("DeepSeek V4 Pro (1M)"));
  assert.doesNotMatch(patch.to, /\["Opus 4\.8"/);
  assert.doesNotMatch(patch.to, /GPT-5\.6 Sol/);
  assert.doesNotMatch(patch.to, /\["Opus 4\.7"/);
  assert.doesNotMatch(patch.to, /GPT-5\.6 Luna/);
  assert.doesNotMatch(patch.to, /\["Fable 5"/);
  assert.doesNotMatch(patch.to, /\["Opus 4\.5"/);
  assert.doesNotMatch(patch.to, /\["Sonnet 4\.5"/);
  assert.doesNotMatch(patch.to, /\["Opus 5"/);
  assert.doesNotMatch(patch.to, /\["Sonnet 5"/);
  assert.doesNotMatch(patch.to, /\["Haiku 4\.5"/);
});

test("model label patch rejects a non-exact anchor shape", () => {
  assert.throws(
    () => buildModelLabelPatch("/chunk.js", "function make(){return view}"),
    /unexpected shape/,
  );
});

test("environment patch injects the unix socket alongside the loopback router", () => {
  const patch = buildEnvironmentPatch({
    routerBaseUrl: "http://127.0.0.1:10102",
    routerSocketPath: "/tmp/claude-hybrid-router.sock",
  });
  assert.match(patch, /ANTHROPIC_BASE_URL:"http:\/\/127\.0\.0\.1:10102"/);
  assert.match(patch, /ANTHROPIC_UNIX_SOCKET:"\/tmp\/claude-hybrid-router\.sock"/);
  assert.match(patch, /ANTHROPIC_CUSTOM_MODEL_OPTION:"deepseek-v4-pro\[1m]"/);
  assert.match(patch, /ANTHROPIC_DEFAULT_HAIKU_MODEL:"deepseek-v4-flash"/);
  assert.doesNotMatch(patch, /ANTHROPIC_DEFAULT_OPUS_MODEL/);
  assert.doesNotMatch(patch, /ANTHROPIC_DEFAULT_SONNET_MODEL/);
  assert.throws(
    () => buildEnvironmentPatch({ routerBaseUrl: "http://127.0.0.1:10102", routerSocketPath: "relative.sock" }),
    /absolute path/,
  );
});
