/** One long-prompt price tier: applies when a single call's whole prompt (cached tokens included) reaches `minPromptTokens`. All prices are USD per 1M tokens. */
export interface PriceTier {
  minPromptTokens: number;
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** A model's prices in USD per 1M tokens (web search is USD per call). */
export interface PriceBlock {
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  image?: number;
  imageOutput?: number;
  audio?: number;
  audioOutput?: number;
  webSearch?: number;
  contextLength?: number;
  tiers: PriceTier[];
}

export type PriceSource = 'openrouter' | 'manual';
export type PriceKind = 'chat' | 'embedding';
/** `ok` has a price and is listed; `not_listed` kept its last price but OpenRouter dropped it; `no_price` is used but never priced. */
export type ModelPriceStatus = 'ok' | 'not_listed' | 'no_price';
export type PriceVersionSource = 'sync' | 'sync_now' | 'override_set' | 'override_cleared';
export type PriceChangeKind = 'price_changed' | 'unpriced' | 'not_listed' | 'sync_failing';
export type PriceDiffKind = 'changed' | 'added' | 'removed' | 'unchanged';

export interface PriceDiffLine {
  /** `prompt`, `cacheRead`, `tier:100000:completion`, … */
  field: string;
  previous: number | null;
  current: number | null;
  change: number | null;
  changePct: number | null;
  kind: PriceDiffKind;
}

export interface PriceOverride {
  price: PriceBlock;
  reason: string;
  setBy?: string;
  setAt: Date;
  until?: Date | null;
}

export interface IModelPrice {
  modelId: string;
  /** Other ids OpenRouter knows the model by (its canonical slug). */
  aliases: string[];
  name?: string;
  kind: PriceKind;
  /** Last synced price; absent until the first successful sync lists the model. */
  price?: PriceBlock;
  override?: PriceOverride | null;
  status: ModelPriceStatus;
  /** Where the model is used (`endpoint:OpenRouter`, `spec:office-assistant`, `title`, `ledger`, …). */
  usedFor: string[];
  fetchedAt?: Date;
  lastChangedAt?: Date;
  /** Count of stored versions; the current one is `version`. */
  version: number;
  /** Times a call was billed at the highest price because the model had none. */
  unpricedHits: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IModelPriceVersion {
  modelId: string;
  version: number;
  effectiveFrom: Date;
  source: PriceVersionSource;
  /** Whose price this is: the synced OpenRouter one or a manual override. */
  priceSource: PriceSource;
  price: PriceBlock;
  previous?: PriceBlock | null;
  diff: PriceDiffLine[];
  actor?: string;
  note?: string;
}

export interface IModelPriceChange {
  modelId: string;
  kind: PriceChangeKind;
  version?: number;
  summary: string;
  diff: PriceDiffLine[];
  seenAt?: Date | null;
  seenBy?: string;
  createdAt?: Date;
}

export interface IModelPriceSync {
  trigger: 'startup' | 'timer' | 'manual';
  startedAt: Date;
  finishedAt?: Date;
  ok: boolean;
  models: number;
  changed: number;
  notListed: number;
  unpriced: number;
  error?: string;
  actor?: string;
}
