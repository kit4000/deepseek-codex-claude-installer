import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { generateCatalog } from "../scripts/generate-catalog.mjs";

const routerConfig = {
  native: { baseUrl: "https://chatgpt.com/backend-api/codex" },
  routes: [],
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("refreshes the native snapshot so newly launched models are included", async () => {
  const codexHome = await mkdtemp(resolve(tmpdir(), "codex-catalog-home-"));
  const routerConfigPath = resolve(codexHome, "router-config.json");
  const outputPath = resolve(codexHome, "model-catalogs/native-plus-external.json");
  const cachePath = resolve(codexHome, "models_cache.json");
  const pristinePath = resolve(codexHome, "model-catalogs/native-pristine.json");

  await writeJson(routerConfigPath, routerConfig);
  await writeJson(cachePath, {
    models: [{
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      model_messages: { instructions_template: "GPT-6 instructions" },
    }],
  });
  await generateCatalog({ codexHome, routerConfigPath, outputPath });

  const pristine = JSON.parse(await readFile(pristinePath, "utf8"));
  const merged = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(pristine.models[0].slug, "gpt-6-astra");
  assert.equal(merged.models[0].slug, "gpt-6-astra");
  assert.equal(merged.models[0].base_instructions, "GPT-6 instructions");
  assert.equal(merged.models[0].supports_parallel_tool_calls, true);

  await writeJson(cachePath, {
    models: [{
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      model_messages: { instructions_template: "GPT-6 updated instructions" },
    }, {
      slug: "gpt-7-nova",
      display_name: "GPT-7-Nova",
      model_messages: { instructions_template: "GPT-7 instructions" },
    }],
  });
  await generateCatalog({ codexHome, routerConfigPath, outputPath });

  const refreshed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(refreshed.models.map(({ slug }) => slug), ["gpt-6-astra", "gpt-7-nova"]);
});
