/**
 * Fails when a model named in librechat.yaml has no price or OpenRouter no longer lists it.
 *   npm run check:prices                      reads https://openrouter.ai/api/v1 (read-only GET)
 *   npm run check:prices -- --models a.json --embeddings b.json   uses saved catalogs (offline)
 *   npm run check:prices -- --config path/to/librechat.yaml
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  UNLISTED_OK,
  parseCatalog,
  fetchAllCatalogs,
  collectConfiguredModels,
} = require('../packages/api/dist/index.cjs');

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function loadCatalog() {
  const models = arg('--models');
  if (!models) {
    return fetchAllCatalogs();
  }
  const embeddings = arg('--embeddings');
  const all = [
    ...parseCatalog(readJson(models), 'chat'),
    ...(embeddings ? parseCatalog(readJson(embeddings), 'embedding') : []),
  ];
  return new Map(all.map((model) => [model.modelId.toLowerCase(), model]));
}

async function main() {
  const configPath = path.resolve(arg('--config') ?? path.join(__dirname, '..', 'librechat.yaml'));
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const configured = collectConfiguredModels(config);
  const catalog = await loadCatalog();

  const problems = [];
  for (const [model, uses] of [...configured].sort(([a], [b]) => a.localeCompare(b))) {
    const where = [...uses].join(', ');
    if (catalog.has(model.toLowerCase())) {
      console.log(`ok       ${model}  (${where})`);
    } else if (UNLISTED_OK[model]) {
      console.log(`ok       ${model}  (${where}) priced outside OpenRouter: ${UNLISTED_OK[model]}`);
    } else {
      problems.push(model);
      console.log(
        `MISSING  ${model}  (${where}) not listed on OpenRouter, so it has no synced price`,
      );
    }
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} configured model(s) have no price. Fix the model id, remove it, or ` +
        'add it to UNLISTED_OK in packages/api/src/prices/models.ts with a manual price and a reason.',
    );
    process.exit(1);
  }
  console.log(`\n${configured.size} configured model(s) priced and listed.`);
}

main().catch((error) => {
  console.error(`check:prices could not run: ${error.message}`);
  process.exit(2);
});
