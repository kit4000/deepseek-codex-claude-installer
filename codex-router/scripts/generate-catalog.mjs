import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCatalog } from "../src/lib.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export async function generateCatalog({ codexHome, routerConfigPath, outputPath }) {
  const pristineCatalogPath = resolve(codexHome, "model-catalogs/native-pristine.json");
  await mkdir(dirname(pristineCatalogPath), { recursive: true });
  try {
    await access(pristineCatalogPath, constants.R_OK);
  } catch {
    await copyFile(resolve(codexHome, "models_cache.json"), pristineCatalogPath, constants.COPYFILE_EXCL);
  }
  const [nativeCatalog, routerConfig] = await Promise.all([
    readFile(pristineCatalogPath, "utf8").then(JSON.parse),
    readFile(routerConfigPath, "utf8").then(JSON.parse),
  ]);
  const merged = mergeCatalog(nativeCatalog, routerConfig);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return {
    modelCount: merged.models.length,
    externalCount: merged.models.length - nativeCatalog.models.length,
    pristineCatalogPath,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  const routerConfigPath = process.env.CODEX_MODEL_ROUTER_CONFIG ?? resolve(projectRoot, "router-config.json");
  const outputPath = process.env.CODEX_MODEL_CATALOG ?? resolve(codexHome, "model-catalogs/native-plus-external.json");
  const result = await generateCatalog({ codexHome, routerConfigPath, outputPath });
  console.log(JSON.stringify({ outputPath, ...result }));
}
