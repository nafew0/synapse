import type { Model } from 'mongoose';
import type {
  PriceBlock,
  PriceKind,
  IModelPrice,
  PriceSource,
  IModelPriceSync,
  IModelPriceChange,
  IModelPriceVersion,
  PriceVersionSource,
} from '~/types/modelPrice';
import { diffPrices, samePrice, summarizeDiff } from './diff';
import { loadPriceTable, type PriceEntry } from './table';

export interface PriceStoreModels {
  ModelPrice: Model<IModelPrice>;
  ModelPriceVersion: Model<IModelPriceVersion>;
  ModelPriceChange: Model<IModelPriceChange>;
  ModelPriceSync: Model<IModelPriceSync>;
}

export interface ListedPrice {
  modelId: string;
  aliases?: string[];
  name?: string;
  kind: PriceKind;
  price: PriceBlock;
}

export interface ApplyListedResult {
  created: boolean;
  changed: boolean;
}

export const activeOverride = (doc: IModelPrice, at: Date = new Date()): PriceBlock | undefined => {
  const override = doc.override;
  if (!override || (override.until && override.until.getTime() <= at.getTime())) {
    return undefined;
  }
  return override.price;
};

/** The price billing uses for a stored model: a live manual override, else the synced one. */
export function effectivePrice(
  doc: IModelPrice,
  at: Date = new Date(),
): { price: PriceBlock; source: PriceSource } | undefined {
  const override = activeOverride(doc, at);
  if (override) {
    return { price: override, source: 'manual' };
  }
  return doc.price ? { price: doc.price, source: 'openrouter' } : undefined;
}

export interface PriceStore {
  applyListed: (
    listed: ListedPrice,
    options: { at: Date; source: PriceVersionSource; actor?: string; usedFor?: string[] },
  ) => Promise<ApplyListedResult>;
  markNotListed: (modelId: string, at: Date, usedFor?: string[]) => Promise<boolean>;
  recordUnpriced: (modelId: string, reason: 'unknown' | 'fallback') => Promise<void>;
  setOverride: (
    modelId: string,
    input: { price: PriceBlock; reason: string; until?: Date | null; actor?: string },
    at?: Date,
  ) => Promise<IModelPrice>;
  clearOverride: (modelId: string, actor?: string, at?: Date) => Promise<IModelPrice | null>;
  startSync: (
    trigger: IModelPriceSync['trigger'],
    actor?: string,
  ) => Promise<IModelPriceSync & { _id: unknown }>;
  finishSync: (
    id: unknown,
    result: Partial<
      Pick<IModelPriceSync, 'ok' | 'models' | 'changed' | 'notListed' | 'unpriced' | 'error'>
    >,
  ) => Promise<void>;
  refreshTable: (at?: Date) => Promise<number>;
}

export function createPriceStore(models: PriceStoreModels): PriceStore {
  const { ModelPrice, ModelPriceVersion, ModelPriceChange, ModelPriceSync } = models;

  async function recordVersion(
    doc: { modelId: string; version: number },
    fields: Omit<IModelPriceVersion, 'modelId' | 'version' | 'diff'> & { diff?: never },
  ): Promise<IModelPriceVersion> {
    const diff = diffPrices(fields.previous, fields.price);
    const created = await ModelPriceVersion.create({
      ...fields,
      modelId: doc.modelId,
      version: doc.version,
      diff,
    });
    return created.toObject();
  }

  /** Stores what OpenRouter lists for one model. Same price → only `fetchedAt` moves; a different one → new version, notice. */
  async function applyListed(
    listed: ListedPrice,
    options: { at: Date; source: PriceVersionSource; actor?: string; usedFor?: string[] },
  ): Promise<ApplyListedResult> {
    const { at, source, actor } = options;
    const existing = await ModelPrice.findOne({ modelId: listed.modelId }).lean<IModelPrice>();
    const aliases = listed.aliases ?? [];
    const usedFor = options.usedFor ?? existing?.usedFor ?? [];

    if (existing?.price && samePrice(existing.price, listed.price)) {
      await ModelPrice.updateOne(
        { modelId: listed.modelId },
        { $set: { fetchedAt: at, status: 'ok', aliases, name: listed.name, usedFor } },
      );
      return { created: false, changed: false };
    }

    const manualLive = existing != null && activeOverride(existing, at) != null;
    const bumped = await ModelPrice.findOneAndUpdate(
      { modelId: listed.modelId },
      {
        $set: {
          price: listed.price,
          kind: listed.kind,
          aliases,
          name: listed.name,
          status: 'ok',
          usedFor,
          fetchedAt: at,
          lastChangedAt: at,
        },
        $inc: { version: 1 },
        $setOnInsert: { override: null },
      },
      { upsert: true, new: true },
    ).lean<IModelPrice>();
    const version = bumped?.version ?? 1;
    const versionDoc = await recordVersion(
      { modelId: listed.modelId, version },
      {
        effectiveFrom: at,
        source,
        priceSource: 'openrouter',
        price: listed.price,
        previous: existing?.price ?? null,
        actor,
        note: manualLive ? 'A manual override is active and still wins' : undefined,
      },
    );
    if (existing?.price) {
      await ModelPriceChange.create({
        modelId: listed.modelId,
        kind: 'price_changed',
        version,
        summary: summarizeDiff(listed.modelId, versionDoc.diff, listed.name ?? existing?.name),
        diff: versionDoc.diff,
      });
    }
    return { created: existing == null, changed: existing?.price != null };
  }

  /** A model in use that OpenRouter no longer lists keeps its last price and is flagged once. */
  async function markNotListed(modelId: string, at: Date, usedFor?: string[]): Promise<boolean> {
    const existing = await ModelPrice.findOne({ modelId }).lean<IModelPrice>();
    const status = existing?.price ? 'not_listed' : 'no_price';
    await ModelPrice.updateOne(
      { modelId },
      {
        $set: { status, ...(usedFor ? { usedFor } : {}) },
        $setOnInsert: { kind: 'chat', aliases: [], version: 0, override: null },
      },
      { upsert: true },
    );
    const alreadyOpen = await ModelPriceChange.exists({
      modelId,
      kind: status === 'no_price' ? 'unpriced' : 'not_listed',
      seenAt: null,
    });
    if (!alreadyOpen) {
      await ModelPriceChange.create({
        modelId,
        kind: status === 'no_price' ? 'unpriced' : 'not_listed',
        summary:
          status === 'no_price'
            ? `${modelId} has no price: OpenRouter does not list it`
            : `${modelId} is no longer listed on OpenRouter; its last price is kept`,
        createdAt: at,
      });
    }
    return !alreadyOpen;
  }

  /** Records that billing met a model with no price; the first sighting opens a notice. */
  async function recordUnpriced(modelId: string, reason: 'unknown' | 'fallback'): Promise<void> {
    await ModelPrice.updateOne(
      { modelId },
      {
        $inc: { unpricedHits: 1 },
        $setOnInsert: { kind: 'chat', aliases: [], version: 0, override: null, status: 'no_price' },
      },
      { upsert: true },
    );
    if (reason !== 'unknown') {
      return;
    }
    const open = await ModelPriceChange.exists({ modelId, kind: 'unpriced', seenAt: null });
    if (!open) {
      await ModelPriceChange.create({
        modelId,
        kind: 'unpriced',
        summary: `${modelId} was billed with no price: highest price applied until one is set`,
      });
    }
  }

  async function setOverride(
    modelId: string,
    input: { price: PriceBlock; reason: string; until?: Date | null; actor?: string },
    at: Date = new Date(),
  ): Promise<IModelPrice> {
    const existing = await ModelPrice.findOne({ modelId }).lean<IModelPrice>();
    const previous = existing ? effectivePrice(existing, at)?.price : undefined;
    const updated = await ModelPrice.findOneAndUpdate(
      { modelId },
      {
        $set: {
          override: {
            price: input.price,
            reason: input.reason,
            setBy: input.actor,
            setAt: at,
            until: input.until ?? null,
          },
          lastChangedAt: at,
        },
        $inc: { version: 1 },
        $setOnInsert: { kind: 'chat', aliases: [], status: 'ok', usedFor: [] },
      },
      { upsert: true, new: true },
    ).lean<IModelPrice>();
    const version = updated?.version ?? 1;
    await recordVersion(
      { modelId, version },
      {
        effectiveFrom: at,
        source: 'override_set',
        priceSource: 'manual',
        price: input.price,
        previous: previous ?? null,
        actor: input.actor,
        note: input.reason,
      },
    );
    return updated as IModelPrice;
  }

  async function clearOverride(
    modelId: string,
    actor?: string,
    at: Date = new Date(),
  ): Promise<IModelPrice | null> {
    const existing = await ModelPrice.findOne({ modelId }).lean<IModelPrice>();
    if (!existing?.override) {
      return existing;
    }
    const restored = existing.price;
    const updated = await ModelPrice.findOneAndUpdate(
      { modelId },
      restored
        ? { $set: { override: null, lastChangedAt: at }, $inc: { version: 1 } }
        : { $set: { override: null } },
      { new: true },
    ).lean<IModelPrice>();
    const version = updated?.version ?? existing.version;
    if (restored) {
      await recordVersion(
        { modelId, version },
        {
          effectiveFrom: at,
          source: 'override_cleared',
          priceSource: 'openrouter',
          price: restored,
          previous: existing.override.price,
          actor,
          note: 'Manual override removed; synced price restored',
        },
      );
    }
    return updated;
  }

  async function startSync(
    trigger: IModelPriceSync['trigger'],
    actor?: string,
  ): Promise<IModelPriceSync & { _id: unknown }> {
    const run = await ModelPriceSync.create({ trigger, startedAt: new Date(), actor });
    return run.toObject() as IModelPriceSync & { _id: unknown };
  }

  async function finishSync(
    id: unknown,
    result: Partial<
      Pick<IModelPriceSync, 'ok' | 'models' | 'changed' | 'notListed' | 'unpriced' | 'error'>
    >,
  ): Promise<void> {
    await ModelPriceSync.updateOne({ _id: id }, { $set: { ...result, finishedAt: new Date() } });
  }

  /** Reads every stored price into the in-memory table billing uses. */
  async function refreshTable(at: Date = new Date()): Promise<number> {
    const docs = await ModelPrice.find({}).lean<IModelPrice[]>();
    const entries = docs.flatMap((doc) => {
      const effective = effectivePrice(doc, at);
      return effective
        ? [
            { modelId: doc.modelId, aliases: doc.aliases, ...effective } as PriceEntry & {
              aliases: string[];
            },
          ]
        : [];
    });
    loadPriceTable(entries, at);
    return entries.length;
  }

  return {
    applyListed,
    markNotListed,
    recordUnpriced,
    setOverride,
    clearOverride,
    startSync,
    finishSync,
    refreshTable,
  };
}
