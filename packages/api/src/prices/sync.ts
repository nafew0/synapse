import { logger } from '@librechat/data-schemas';
import type {
  PriceStore,
  IModelPrice,
  PriceStoreModels,
  IModelPriceChange,
  IModelPriceSync,
  PriceVersionSource,
} from '@librechat/data-schemas';
import type { CatalogOptions, CatalogModel } from './openrouter';
import type { ModelUses } from './models';
import { fetchAllCatalogs } from './openrouter';
import { UNLISTED_OK } from './models';
import { acquireLock } from './lock';

export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FAILURE_NOTICE_MS = 24 * 60 * 60 * 1000;
const LOCK_KEY = 'model-price-sync';
const LOCK_TTL_SECONDS = 120;

export interface SyncDeps {
  models: PriceStoreModels;
  store: PriceStore;
  /** Model ids in use, with where; read fresh on every run. */
  collectModels: () => Promise<ModelUses>;
  catalog?: CatalogOptions;
  now?: () => Date;
}

export interface SyncResult {
  skipped?: 'locked';
  ok: boolean;
  models: number;
  changed: number;
  created: number;
  notListed: number;
  error?: string;
}

const empty = (extra: Partial<SyncResult>): SyncResult => ({
  ok: false,
  models: 0,
  changed: 0,
  created: 0,
  notListed: 0,
  ...extra,
});

async function noteFailure(deps: SyncDeps, message: string, at: Date): Promise<void> {
  const { ModelPriceSync, ModelPriceChange } = deps.models;
  const lastGood = await ModelPriceSync.findOne({ ok: true })
    .sort({ startedAt: -1 })
    .lean<IModelPriceSync>();
  const since = lastGood?.startedAt?.getTime() ?? 0;
  if (at.getTime() - since < FAILURE_NOTICE_MS) {
    return;
  }
  const open = await ModelPriceChange.exists({ kind: 'sync_failing', seenAt: null });
  if (!open) {
    await ModelPriceChange.create({
      modelId: '*',
      kind: 'sync_failing',
      summary: `Price sync has failed for over 24 hours: ${message}`,
    });
  }
}

/**
 * One price sync: reads both OpenRouter catalogs, stores what changed for every model in use and
 * leaves everything as it was if a request fails. One server runs it at a time (Redis lock when
 * Redis is on). Prices are never cleared because a fetch failed.
 */
export async function runPriceSync(
  deps: SyncDeps,
  options: { trigger: IModelPriceSync['trigger']; actor?: string } = { trigger: 'timer' },
): Promise<SyncResult> {
  const { store, models } = deps;
  const lock = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  if (!lock.acquired) {
    return empty({ skipped: 'locked' });
  }
  const at = (deps.now ?? (() => new Date()))();
  const run = await store.startSync(options.trigger, options.actor);
  try {
    const [uses, catalog] = await Promise.all([
      deps.collectModels(),
      fetchAllCatalogs(deps.catalog),
    ]);
    const source: PriceVersionSource = options.trigger === 'manual' ? 'sync_now' : 'sync';
    let changed = 0;
    let created = 0;
    let notListed = 0;
    for (const [modelId, useSet] of uses) {
      const usedFor = [...useSet];
      const listed: CatalogModel | undefined = catalog.get(modelId.toLowerCase());
      if (!listed) {
        if (UNLISTED_OK[modelId]) {
          await models.ModelPrice.updateOne(
            { modelId },
            {
              $set: { usedFor },
              $setOnInsert: { kind: 'chat', aliases: [], version: 0, status: 'no_price' },
            },
            { upsert: true },
          );
          continue;
        }
        notListed += 1;
        await store.markNotListed(modelId, at, usedFor);
        continue;
      }
      const result = await store.applyListed(
        { ...listed, modelId },
        { at, source, actor: options.actor, usedFor },
      );
      changed += result.changed ? 1 : 0;
      created += result.created ? 1 : 0;
    }
    await store.refreshTable(at);
    await models.ModelPriceChange.updateMany(
      { kind: 'sync_failing', seenAt: null },
      { $set: { seenAt: at, seenBy: 'system' } },
    );
    const unpriced = await models.ModelPrice.countDocuments({
      status: 'no_price',
      usedFor: { $ne: [] },
    });
    await store.finishSync(run._id, { ok: true, models: uses.size, changed, notListed, unpriced });
    logger.info(
      `[ModelPrice] Synced ${uses.size} model(s): ${created} new, ${changed} changed, ${notListed} not listed`,
    );
    return { ok: true, models: uses.size, changed, created, notListed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ModelPrice] Sync failed, last prices kept: ${message}`);
    await store.finishSync(run._id, { ok: false, error: message });
    await noteFailure(deps, message, at).catch((noteError) =>
      logger.error('[ModelPrice] could not record sync failure notice', noteError),
    );
    return empty({ error: message });
  } finally {
    await lock.release();
  }
}

export type { IModelPrice, IModelPriceChange };
