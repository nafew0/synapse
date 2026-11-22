import type { PriceBlock, PriceKind, PriceTier } from '@librechat/data-schemas';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const FETCH_TIMEOUT_MS = 10_000;

interface RawOverride {
  min_prompt_tokens?: number | string;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_cache_write_1h?: string;
}

interface RawPricing extends RawOverride {
  image?: string;
  image_output?: string;
  audio?: string;
  audio_output?: string;
  web_search?: string;
  internal_reasoning?: string;
  overrides?: RawOverride[];
}

interface RawModel {
  id?: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number | null;
  pricing?: RawPricing;
}

export interface CatalogModel {
  modelId: string;
  aliases: string[];
  name?: string;
  kind: PriceKind;
  price: PriceBlock;
}

/** OpenRouter prices are USD per token as strings; the table works in USD per 1M tokens. */
export function perMillion(value: string | number | undefined): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Number((parsed * 1e6).toPrecision(10))
    : undefined;
}

const perCall = (value: string | undefined): number | undefined => {
  const parsed = value == null ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

function parseTier(raw: RawOverride): PriceTier | undefined {
  const minPromptTokens = Number(raw.min_prompt_tokens);
  const prompt = perMillion(raw.prompt);
  const completion = perMillion(raw.completion);
  if (!Number.isFinite(minPromptTokens) || minPromptTokens <= 0) {
    return undefined;
  }
  if (prompt == null || completion == null) {
    return undefined;
  }
  return {
    minPromptTokens,
    prompt,
    completion,
    cacheRead: perMillion(raw.input_cache_read),
    cacheWrite: perMillion(raw.input_cache_write),
    cacheWrite1h: perMillion(raw.input_cache_write_1h),
  };
}

/** Drops undefined fields so two parses of the same listing compare equal in Mongo and in tests. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** A model's `pricing` block as a price: undefined when it lacks a usable prompt price. */
export function parsePricing(
  pricing: RawPricing | undefined,
  contextLength?: number | null,
): PriceBlock | undefined {
  const prompt = perMillion(pricing?.prompt);
  if (!pricing || prompt == null) {
    return undefined;
  }
  const tiers = (pricing.overrides ?? [])
    .map(parseTier)
    .filter((tier): tier is PriceTier => tier != null)
    .map(compact)
    .sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  return compact({
    prompt,
    completion: perMillion(pricing.completion) ?? 0,
    cacheRead: perMillion(pricing.input_cache_read),
    cacheWrite: perMillion(pricing.input_cache_write),
    cacheWrite1h: perMillion(pricing.input_cache_write_1h),
    reasoning: perMillion(pricing.internal_reasoning),
    image: perMillion(pricing.image),
    imageOutput: perMillion(pricing.image_output),
    audio: perMillion(pricing.audio),
    audioOutput: perMillion(pricing.audio_output),
    webSearch: perCall(pricing.web_search),
    contextLength: contextLength || undefined,
    tiers,
  });
}

export function parseCatalog(body: { data?: RawModel[] }, kind: PriceKind): CatalogModel[] {
  const models = Array.isArray(body?.data) ? body.data : [];
  return models.flatMap((raw) => {
    const price = parsePricing(raw.pricing, raw.context_length);
    if (!raw.id || !price) {
      return [];
    }
    const aliases = raw.canonical_slug && raw.canonical_slug !== raw.id ? [raw.canonical_slug] : [];
    return [{ modelId: raw.id, aliases, name: raw.name, kind, price }];
  });
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface CatalogOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** One catalog request. Throws on a network error, a non-2xx answer or a body that is not a model list. */
export async function fetchCatalog(
  path: 'models' | 'embeddings/models',
  options: CatalogOptions = {},
): Promise<CatalogModel[]> {
  const {
    baseUrl = OPENROUTER_API,
    fetchImpl = fetch as FetchLike,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options;
  const response = await fetchImpl(`${baseUrl}/${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /${path} answered ${response.status}`);
  }
  const body = (await response.json()) as { data?: RawModel[] };
  if (!Array.isArray(body?.data)) {
    throw new Error(`OpenRouter /${path} returned no model list`);
  }
  return parseCatalog(body, path === 'models' ? 'chat' : 'embedding');
}

/** Both catalogs, or an error: a half answer never reaches the store. */
export async function fetchAllCatalogs(
  options: CatalogOptions = {},
): Promise<Map<string, CatalogModel>> {
  const [chat, embeddings] = await Promise.all([
    fetchCatalog('models', options),
    fetchCatalog('embeddings/models', options),
  ]);
  const byId = new Map<string, CatalogModel>();
  for (const model of [...embeddings, ...chat]) {
    byId.set(model.modelId.toLowerCase(), model);
    for (const alias of model.aliases) {
      if (!byId.has(alias.toLowerCase())) {
        byId.set(alias.toLowerCase(), model);
      }
    }
  }
  return byId;
}
