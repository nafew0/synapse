import mongoose from 'mongoose';
import {
  logger,
  createPriceStore,
  runAsSystem,
  setUnpricedSink,
  setPriceExemptions,
} from '@librechat/data-schemas';
import type { PriceStore, PriceStoreModels, IModelPrice } from '@librechat/data-schemas';
import type { PriceConfigSource, ModelUses } from './models';
import { addUsedModels, collectConfiguredModels, UNLISTED_OK } from './models';
import { runPriceSync, SYNC_INTERVAL_MS } from './sync';

/** How often each server re-reads stored prices, so a sync or override made on another server applies within a minute. */
export const REFRESH_INTERVAL_MS: number = 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;
const LEDGER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const priceModels = (): PriceStoreModels => ({
  ModelPrice: mongoose.models.ModelPrice,
  ModelPriceVersion: mongoose.models.ModelPriceVersion,
  ModelPriceChange: mongoose.models.ModelPriceChange,
  ModelPriceSync: mongoose.models.ModelPriceSync,
});

export const priceStore = (): PriceStore => createPriceStore(priceModels());

/** Config models plus agents' models and every model the ledger saw in the last 30 days. */
export async function collectModelsInUse(
  config: PriceConfigSource | undefined | null,
): Promise<ModelUses> {
  const uses = collectConfiguredModels(config);
  const since = new Date(Date.now() - LEDGER_WINDOW_MS);
  const [agentModels, ledgerModels] = await runAsSystem(() =>
    Promise.all([
      mongoose.models.Agent?.distinct('model') ?? [],
      mongoose.models.Transaction?.distinct('model', { createdAt: { $gte: since } }) ?? [],
    ]),
  );
  addUsedModels(uses, agentModels as string[], 'agent');
  addUsedModels(uses, ledgerModels as string[], 'ledger');
  return uses;
}

export interface PriceJobOptions {
  /** Loads the base app config (the parsed librechat.yaml). */
  getConfig: () => Promise<PriceConfigSource | undefined | null>;
  intervalMs?: number;
}

/**
 * Starts the price jobs on this server: a sync shortly after startup and every 6 hours (one server
 * at a time), a minute-by-minute reload of the in-memory table billing reads, and the sink that
 * records models billed with no price. Returns a function that stops them.
 */
export function startPriceSync(options: PriceJobOptions): () => void {
  const store = priceStore();
  setPriceExemptions(Object.keys(UNLISTED_OK));
  setUnpricedSink((model, reason) => {
    store.recordUnpriced(model, reason).catch((error) => {
      logger.error('[ModelPrice] could not record unpriced model', error);
    });
  });

  const refresh = async (): Promise<void> => {
    try {
      await store.refreshTable();
    } catch (error) {
      logger.error('[ModelPrice] price table reload failed', error);
    }
  };
  const sync = async (trigger: 'startup' | 'timer'): Promise<void> => {
    try {
      await runPriceSync(
        {
          models: priceModels(),
          store,
          collectModels: async () => collectModelsInUse(await options.getConfig()),
        },
        { trigger },
      );
    } catch (error) {
      logger.error('[ModelPrice] sync job failed', error);
    }
  };

  void refresh();
  const first = setTimeout(() => void sync('startup'), STARTUP_DELAY_MS);
  const syncTimer = setInterval(() => void sync('timer'), options.intervalMs ?? SYNC_INTERVAL_MS);
  const refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  [first, syncTimer, refreshTimer].forEach((timer) => timer.unref());
  return () => {
    clearTimeout(first);
    clearInterval(syncTimer);
    clearInterval(refreshTimer);
    setUnpricedSink(null);
  };
}

export type { IModelPrice };
