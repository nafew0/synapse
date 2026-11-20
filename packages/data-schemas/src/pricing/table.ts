import type { PriceBlock, PriceSource, PriceTier } from '~/types/modelPrice';
import logger from '~/config/winston';

/** What one call is billed at, USD per 1M tokens. A missing cache rate means "no cache price", so callers fall back to the input rate. */
export interface Rates {
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceEntry {
  modelId: string;
  price: PriceBlock;
  source: PriceSource;
}

export type UnpricedReason = 'unknown' | 'fallback';
export type UnpricedSink = (model: string, reason: UnpricedReason) => void;

let table = new Map<string, PriceEntry>();
let loadedAt: Date | null = null;
let sink: UnpricedSink | null = null;
const flagged = new Map<string, UnpricedReason>();
let exempt = new Set<string>();

/** Models priced outside the table on purpose; billing them from the built-in tables raises no flag. */
export const setPriceExemptions = (models: Iterable<string>): void => {
  exempt = new Set([...models].map(normalizeModelId));
};

/** Lowercases and drops an OpenRouter routing suffix (`:nitro`, `:thinking`); nothing else is guessed. */
export const normalizeModelId = (model: string): string => model.trim().toLowerCase().split(':')[0];

/** Replaces the in-memory table the billing functions read. `aliases` map extra ids to the same price. */
export function loadPriceTable(
  entries: Array<PriceEntry & { aliases?: string[] }>,
  at: Date = new Date(),
): void {
  const next = new Map<string, PriceEntry>();
  for (const { aliases = [], ...entry } of entries) {
    next.set(normalizeModelId(entry.modelId), entry);
    for (const alias of aliases) {
      const key = normalizeModelId(alias);
      if (!next.has(key)) {
        next.set(key, entry);
      }
    }
  }
  table = next;
  loadedAt = at;
}

export const clearPriceTable = (): void => {
  table = new Map();
  loadedAt = null;
  flagged.clear();
};

export const isPriceTableLoaded = (): boolean => table.size > 0;
export const getPriceTableLoadedAt = (): Date | null => loadedAt;

export function findPrice(model?: string): PriceEntry | undefined {
  if (!model || typeof model !== 'string') {
    return undefined;
  }
  return table.get(normalizeModelId(model));
}

/** The tier a prompt of `inputTokenCount` falls in: the highest `minPromptTokens` it reaches (inclusive, as OpenRouter applies it). */
export function tierFor(price: PriceBlock, inputTokenCount?: number | null): PriceTier | undefined {
  if (inputTokenCount == null || price.tiers.length === 0) {
    return undefined;
  }
  return price.tiers
    .filter((tier) => inputTokenCount >= tier.minPromptTokens)
    .reduce<
      PriceTier | undefined
    >((best, tier) => (!best || tier.minPromptTokens > best.minPromptTokens ? tier : best), undefined);
}

/** Rates for one call. A tier that omits a cache rate scales the base one by its prompt-price ratio. */
export function ratesFor(price: PriceBlock, inputTokenCount?: number | null): Rates {
  const tier = tierFor(price, inputTokenCount);
  if (!tier) {
    return {
      prompt: price.prompt,
      completion: price.completion,
      cacheRead: price.cacheRead,
      cacheWrite: price.cacheWrite,
    };
  }
  const scale = price.prompt > 0 ? tier.prompt / price.prompt : 1;
  const scaled = (base?: number): number | undefined =>
    base == null ? undefined : Number((base * scale).toPrecision(10));
  return {
    prompt: tier.prompt,
    completion: tier.completion,
    cacheRead: tier.cacheRead ?? scaled(price.cacheRead),
    cacheWrite: tier.cacheWrite ?? scaled(price.cacheWrite),
  };
}

/** Dearest price anywhere in the table, tiers included, for a token type; 0 when nothing is loaded. */
export function highestRate(tokenType: 'prompt' | 'completion'): number {
  let highest = 0;
  for (const { price } of table.values()) {
    highest = Math.max(highest, price[tokenType], ...price.tiers.map((tier) => tier[tokenType]));
  }
  return highest;
}

export const setUnpricedSink = (next: UnpricedSink | null): void => {
  sink = next;
};

/** Logs once per process and per model and hands the model to the sink, so superadmins hear about it. */
export function flagUnpriced(model: string | undefined, reason: UnpricedReason): void {
  if (!model || typeof model !== 'string') {
    return;
  }
  const key = normalizeModelId(model);
  if (exempt.has(key)) {
    return;
  }
  if (flagged.get(key) === reason || (reason === 'fallback' && flagged.has(key))) {
    return;
  }
  flagged.set(key, reason);
  logger.error(
    reason === 'unknown'
      ? `[ModelPrice] ${model} has no price anywhere; billing it at the highest price until one is set`
      : `[ModelPrice] ${model} has no synced or manual price; billing from the built-in tables`,
  );
  try {
    sink?.(model, reason);
  } catch (error) {
    logger.error('[ModelPrice] unpriced sink failed', error);
  }
}

export const getFlaggedModels = (): Array<{ model: string; reason: UnpricedReason }> =>
  [...flagged.entries()].map(([model, reason]) => ({ model, reason }));
