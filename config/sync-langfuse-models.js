const os = require('os');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Keeps Langfuse's custom model definitions priced the way the providers
 * actually bill, so Langfuse cost matches real spend.
 *
 * Two price sources:
 *
 *   --source=config (default)
 *     Rates from `librechat.yaml` `endpoints.custom[].tokenConfig` (USD per
 *     1M tokens), for the models listed there.
 *
 *   --source=openrouter
 *     Live rates from https://openrouter.ai/api/v1/models, for every OpenRouter
 *     model in the config (tokenConfig keys and `models.default` of endpoints
 *     whose baseURL is openrouter.ai) plus every custom definition already in
 *     Langfuse. Warns where a config rate has drifted from OpenRouter's.
 *
 * Langfuse usage keys priced (USD per token):
 *   input, output, output_reasoning, input_cache_read, input_cache_creation
 *
 * Traces report reasoning tokens as `output_reasoning`, separate from `output`
 * (`total` is the sum of all parts), so without its own price Langfuse records
 * reasoning as free.
 *
 * The match pattern accepts the model id once or twice in a row, because the
 * tracing path sometimes reports the id doubled (`org/modelorg/model`). Older
 * custom definitions that match the same id under a different name (e.g. a
 * separate "duplicated name" definition) are superseded: deleted once the new
 * definition is in place, so a generation never matches two prices.
 *
 * Langfuse has no update endpoint, so a changed definition is deleted and
 * recreated; if the recreate fails, the previous definition is restored. All
 * custom definitions are backed up to a JSON file before anything is written.
 * Definitions for models outside the chosen source are never touched.
 *
 * Usage:
 *   node config/sync-langfuse-models.js [--dry-run] [--source=config|openrouter]
 *                                       [--config=<path>]
 *
 * Reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or
 * LANGFUSE_HOST) from the environment or the repo's `.env`.
 */

const PER_MILLION = 1_000_000;
const PAGE_SIZE = 100;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const SOURCES = new Set(['config', 'openrouter']);
/** Config rates are hand-written to ~6 significant digits; smaller gaps are rounding, not drift. */
const DRIFT_TOLERANCE = 1e-4;

/** tokenConfig key (USD per 1M) -> Langfuse usage key (USD per token) */
const CONFIG_PRICE_KEYS = [
  ['prompt', 'input'],
  ['completion', 'output'],
  ['completion', 'output_reasoning'],
  ['cacheRead', 'input_cache_read'],
  ['cacheWrite', 'input_cache_creation'],
];

function parseArgs(argv) {
  const args = { dryRun: false, configPath: undefined, source: 'config' };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length).trim();
    } else if (arg.startsWith('--source=')) {
      args.source = arg.slice('--source='.length).trim();
    }
  }
  if (!SOURCES.has(args.source)) {
    throw new Error(`--source must be one of: ${[...SOURCES].join(', ')}`);
  }
  return args;
}

function resolveConfigPath(explicit) {
  const candidate = explicit || process.env.CONFIG_PATH || 'librechat.yaml';
  return path.isAbsolute(candidate) ? candidate : path.resolve(__dirname, '..', candidate);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchPatternFor(modelId) {
  return `(?i)^(${escapeRegex(modelId)}){1,2}$`;
}

/** Compiles a Langfuse (PCRE-style) pattern; `null` if JS cannot parse it. */
function compilePattern(pattern) {
  const caseless = pattern.startsWith('(?i)');
  try {
    return new RegExp(caseless ? pattern.slice(4) : pattern, caseless ? 'i' : '');
  } catch {
    return null;
  }
}

function configPrices(rates) {
  const prices = {};
  for (const [configKey, usageKey] of CONFIG_PRICE_KEYS) {
    if (typeof rates[configKey] === 'number') {
      prices[usageKey] = rates[configKey] / PER_MILLION;
    }
  }
  return prices;
}

/**
 * Maps an OpenRouter `pricing` object to Langfuse usage keys. Image models
 * report generated images as output tokens, so `image_output` wins over the
 * text `completion` rate; reasoning bills at `internal_reasoning` when listed.
 */
function openRouterPrices(pricing) {
  const rate = (key) => {
    const value = Number(pricing[key]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const completion = rate('completion');
  const entries = [
    ['input', rate('prompt')],
    ['output', rate('image_output') ?? completion],
    ['output_reasoning', rate('internal_reasoning') ?? completion],
    ['input_cache_read', rate('input_cache_read')],
    ['input_cache_creation', rate('input_cache_write')],
  ];
  return Object.fromEntries(entries.filter(([, value]) => value != null));
}

function customEndpoints(config) {
  return config?.endpoints?.custom ?? [];
}

/**
 * Rates from every endpoint's tokenConfig. A model priced differently on two
 * endpoints is reported and skipped rather than guessed.
 */
function collectFromConfig(config) {
  const byModel = new Map();
  const conflicts = new Set();

  for (const endpoint of customEndpoints(config)) {
    for (const [modelId, rates] of Object.entries(endpoint.tokenConfig ?? {})) {
      const prices = configPrices(rates);
      const existing = byModel.get(modelId);
      if (existing && !samePrices(existing.prices, prices)) {
        conflicts.add(modelId);
        continue;
      }
      byModel.set(modelId, { modelId, prices });
    }
  }

  for (const modelId of conflicts) {
    byModel.delete(modelId);
  }
  return { targets: [...byModel.values()], conflicts: [...conflicts] };
}

function openRouterModelIds(config) {
  const ids = new Set();
  for (const endpoint of customEndpoints(config)) {
    Object.keys(endpoint.tokenConfig ?? {}).forEach((id) => ids.add(id));
    if (String(endpoint.baseURL ?? '').includes('openrouter.ai')) {
      (endpoint.models?.default ?? []).forEach((id) => ids.add(id));
    }
  }
  return ids;
}

async function fetchOpenRouterCatalog() {
  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`GET ${OPENROUTER_MODELS_URL} -> ${response.status}`);
  }
  const { data } = await response.json();
  return new Map(data.map((model) => [model.id, model.pricing ?? {}]));
}

/**
 * Live OpenRouter rates for configured OpenRouter models and existing custom
 * definitions. Ids OpenRouter's chat catalog does not list (Images-API models,
 * legacy display names) are returned separately and left untouched.
 */
async function collectFromOpenRouter(config, customModels) {
  const catalog = await fetchOpenRouterCatalog();
  const ids = new Set([...openRouterModelIds(config), ...customModels.map((m) => m.modelName)]);
  const targets = [];
  const notInCatalog = [];

  for (const modelId of ids) {
    const pricing = catalog.get(modelId);
    if (pricing) {
      targets.push({ modelId, prices: openRouterPrices(pricing) });
    } else if (/^[\w.-]+\/[\w.:-]+$/.test(modelId)) {
      notInCatalog.push(modelId);
    }
  }
  return { targets, notInCatalog };
}

/** Config rates that disagree with the live OpenRouter rate for the same key. */
function findDrift(config, targets) {
  const configured = new Map(collectFromConfig(config).targets.map((t) => [t.modelId, t.prices]));
  const drift = [];
  for (const { modelId, prices } of targets) {
    const fromConfig = configured.get(modelId);
    if (!fromConfig) {
      continue;
    }
    for (const [key, value] of Object.entries(fromConfig)) {
      if (typeof prices[key] === 'number' && !nearlyEqual(value, prices[key], DRIFT_TOLERANCE)) {
        drift.push({ modelId, key, config: value, openrouter: prices[key] });
      }
    }
  }
  return drift;
}

function nearlyEqual(a, b, tolerance = 1e-9) {
  if (a === b) {
    return true;
  }
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

function samePrices(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (typeof a[key] !== 'number' || typeof b[key] !== 'number' || !nearlyEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function defaultTierPrices(model) {
  const tier = model.pricingTiers?.find((t) => t.isDefault) ?? model.pricingTiers?.[0];
  return tier?.prices ?? {};
}

function createLangfuseClient() {
  const baseUrl = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || '').replace(
    /\/+$/,
    '',
  );
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!baseUrl || !publicKey || !secretKey) {
    throw new Error(
      'Set LANGFUSE_BASE_URL (or LANGFUSE_HOST), LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.',
    );
  }
  const auth = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

  async function request(method, route, body) {
    const response = await fetch(`${baseUrl}/api/public${route}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async function listCustomModels() {
    const models = [];
    for (let page = 1; ; page++) {
      const result = await request('GET', `/models?page=${page}&limit=${PAGE_SIZE}`);
      models.push(...result.data.filter((model) => !model.isLangfuseManaged));
      if (page >= (result.meta?.totalPages ?? 1)) {
        return models;
      }
    }
  }

  return {
    baseUrl,
    listCustomModels,
    createModel: (body) => request('POST', '/models', body),
    deleteModel: (id) => request('DELETE', `/models/${encodeURIComponent(id)}`),
  };
}

function definitionBody(modelName, matchPattern, prices) {
  return {
    modelName,
    matchPattern,
    unit: 'TOKENS',
    pricingTiers: [{ name: 'Standard', isDefault: true, priority: 0, conditions: [], prices }],
  };
}

/** Rebuilds a create body from an existing definition, for rollback. */
function restoreBody(model) {
  return {
    modelName: model.modelName,
    matchPattern: model.matchPattern,
    unit: model.unit,
    startDate: model.startDate ?? undefined,
    tokenizerId: model.tokenizerId ?? undefined,
    tokenizerConfig: model.tokenizerConfig ?? undefined,
    pricingTiers: (model.pricingTiers ?? []).map(
      ({ name, isDefault, priority, conditions, prices }) => ({
        name,
        isDefault,
        priority,
        conditions,
        prices,
      }),
    ),
  };
}

/**
 * Custom definitions under another name whose pattern matches this model id.
 * One that also matches another target is broader than a duplicate and kept.
 */
function findSuperseded(target, compiled, targetIds) {
  const probes = [target.modelId, target.modelId + target.modelId];
  const others = [...targetIds].filter((id) => id !== target.modelId);
  return compiled
    .filter(({ model, regex }) => {
      if (!regex || model.modelName === target.modelId || targetIds.has(model.modelName)) {
        return false;
      }
      return probes.some((probe) => regex.test(probe)) && !others.some((id) => regex.test(id));
    })
    .map(({ model }) => model);
}

function planChanges(targets, customModels) {
  const byName = new Map(customModels.map((model) => [model.modelName, model]));
  const compiled = customModels.map((model) => ({
    model,
    regex: compilePattern(model.matchPattern),
  }));
  const targetIds = new Set(targets.map((target) => target.modelId));

  return targets.map((target) => {
    const matchPattern = matchPatternFor(target.modelId);
    const existing = byName.get(target.modelId);
    const superseded = findSuperseded(target, compiled, targetIds);
    if (!existing) {
      return { action: 'create', target, matchPattern, superseded };
    }
    const unchanged =
      existing.matchPattern === matchPattern &&
      samePrices(defaultTierPrices(existing), target.prices);
    return {
      action: unchanged ? 'unchanged' : 'replace',
      target,
      matchPattern,
      existing,
      superseded,
    };
  });
}

async function applyChange(client, change) {
  const { target, matchPattern, existing } = change;
  const body = definitionBody(target.modelId, matchPattern, target.prices);

  if (change.action === 'create') {
    await client.createModel(body);
  } else if (change.action === 'replace') {
    await client.deleteModel(existing.id);
    try {
      await client.createModel(body);
    } catch (error) {
      await client.createModel(restoreBody(existing));
      throw new Error(`recreate failed, previous definition restored: ${error.message}`);
    }
  }

  for (const model of change.superseded) {
    await client.deleteModel(model.id);
  }
}

function backupDefinitions(baseUrl, customModels) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(os.tmpdir(), `langfuse-models-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ baseUrl, models: customModels }, null, 2));
  return file;
}

function formatPrices(prices) {
  return Object.entries(prices)
    .map(([key, value]) => `${key}=$${Number((value * PER_MILLION).toPrecision(6))}/M`)
    .join(' ');
}

function printChange(change) {
  const label = `${change.action.toUpperCase().padEnd(9)} ${change.target.modelId}`;
  console.log(`  ${label}`);
  console.log(`            ${formatPrices(change.target.prices)}`);
  for (const model of change.superseded) {
    console.log(`            supersedes "${model.modelName}" (${model.matchPattern})`);
  }
}

async function collectTargets(args, config, customModels) {
  if (args.source === 'config') {
    const { targets, conflicts } = collectFromConfig(config);
    for (const modelId of conflicts) {
      console.warn(
        `  SKIP ${modelId}: priced differently on two endpoints; reconcile the config first.`,
      );
    }
    return targets;
  }

  const { targets, notInCatalog } = await collectFromOpenRouter(config, customModels);
  for (const modelId of notInCatalog) {
    console.log(`  SKIP ${modelId}: not in OpenRouter's chat catalog; left untouched.`);
  }
  for (const d of findDrift(config, targets)) {
    console.warn(
      `  DRIFT ${d.modelId} ${d.key}: config $${d.config * PER_MILLION}/M, ` +
        `OpenRouter $${d.openrouter * PER_MILLION}/M. Update tokenConfig to match.`,
    );
  }
  return targets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolveConfigPath(args.configPath);
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const client = createLangfuseClient();
  const customModels = await client.listCustomModels();

  console.log(`Config:   ${configPath}`);
  console.log(`Source:   ${args.source}`);
  console.log(`Langfuse: ${client.baseUrl}${args.dryRun ? ' (dry run)' : ''}`);
  console.log('');

  const targets = await collectTargets(args, config, customModels);
  if (targets.length === 0) {
    console.log('No models to sync.');
    return;
  }

  const changes = planChanges(targets, customModels);
  const pending = changes.filter((c) => c.action !== 'unchanged' || c.superseded.length > 0);
  if (!args.dryRun && pending.length > 0) {
    console.log(`Backup:   ${backupDefinitions(client.baseUrl, customModels)}`);
  }
  console.log('');

  let failures = 0;
  for (const change of changes) {
    if (args.dryRun || !pending.includes(change)) {
      printChange(change);
      continue;
    }
    try {
      await applyChange(client, change);
      printChange(change);
    } catch (error) {
      failures++;
      console.error(`  FAILED    ${change.target.modelId}: ${error.message}`);
    }
  }

  const handled = new Set([
    ...targets.map((target) => target.modelId),
    ...changes.flatMap((change) => change.superseded.map((model) => model.modelName)),
  ]);
  const outside = customModels.map((m) => m.modelName).filter((name) => !handled.has(name));
  if (outside.length > 0) {
    console.log('');
    console.log('Custom Langfuse definitions outside this source (left untouched):');
    outside.forEach((name) => console.log(`  ${name}`));
  }

  if (failures > 0) {
    throw new Error(`${failures} definition(s) failed to sync.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Langfuse model sync failed:', error.message);
    process.exit(1);
  });
