import { z } from 'zod';
import mongoose from 'mongoose';
import { logger, diffPrices, effectivePrice } from '@librechat/data-schemas';
import type {
  PriceStore,
  PriceBlock,
  IModelPrice,
  PriceDiffLine,
  IModelPriceSync,
  PriceStoreModels,
  IModelPriceChange,
  IModelPriceVersion,
  ModelPriceStatus,
  AuditAction,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { SyncDeps, SyncResult } from './sync';
import type { ServerRequest } from '~/types/http';
import { buildAuditContext } from '~/admin/context';
import { runPriceSync } from './sync';
import { costEffect } from './costs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHANGED_DAYS = 7;
const MAX_LIMIT = 200;
const STATUS_RANK: Record<ListStatus, number> = { no_price: 0, not_listed: 1, changed: 2, ok: 3 };
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/;

export type ListStatus = ModelPriceStatus | 'changed';

export interface PriceHandlerDeps {
  models: () => PriceStoreModels;
  store: () => PriceStore;
  /** Model ids in use, as the sync reads them. */
  syncDeps: () => Pick<SyncDeps, 'collectModels' | 'catalog' | 'lockClient' | 'now'>;
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
}

type Handler = (req: ServerRequest, res: Response) => Promise<void>;

export interface PriceHandlers {
  list: Handler;
  changes: Handler;
  detail: Handler;
  diff: Handler;
  markSeen: Handler;
  sync: Handler;
  setOverride: Handler;
  clearOverride: Handler;
}

const tierBody = z.object({
  minPromptTokens: z.number().int().positive(),
  prompt: z.number().min(0).max(1e5),
  completion: z.number().min(0).max(1e5),
  cacheRead: z.number().min(0).max(1e5).optional(),
  cacheWrite: z.number().min(0).max(1e5).optional(),
  cacheWrite1h: z.number().min(0).max(1e5).optional(),
});

const priceBody = z.object({
  prompt: z.number().min(0).max(1e5),
  completion: z.number().min(0).max(1e5),
  cacheRead: z.number().min(0).max(1e5).optional(),
  cacheWrite: z.number().min(0).max(1e5).optional(),
  cacheWrite1h: z.number().min(0).max(1e5).optional(),
  reasoning: z.number().min(0).max(1e5).optional(),
  image: z.number().min(0).max(1e5).optional(),
  imageOutput: z.number().min(0).max(1e5).optional(),
  audio: z.number().min(0).max(1e5).optional(),
  audioOutput: z.number().min(0).max(1e5).optional(),
  webSearch: z.number().min(0).max(1e3).optional(),
  contextLength: z.number().int().positive().optional(),
  tiers: z.array(tierBody).max(8).default([]),
});

const overrideBody = z.object({
  price: priceBody,
  reason: z.string().trim().min(3).max(500),
  until: z.coerce.date().nullable().optional(),
});

const actorOf = (req: ServerRequest): { id?: string; name: string } => ({
  id: req.user?.id,
  name: req.user?.name || req.user?.email || 'platform-superadmin',
});

const modelIdOf = (req: ServerRequest): string | undefined => {
  const raw = (req.params as { modelId?: string }).modelId;
  return typeof raw === 'string' && MODEL_ID.test(raw) ? raw : undefined;
};

const limitOf = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_LIMIT) : fallback;
};

const dateOf = (value: unknown): Date | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

function longPrompt(price?: PriceBlock): string | null {
  const tier = price?.tiers[price.tiers.length - 1];
  if (!price || !tier || price.prompt <= 0) {
    return null;
  }
  const times = Number((tier.prompt / price.prompt).toPrecision(3));
  return `×${times} above ${tier.minPromptTokens.toLocaleString('en-US')} tokens`;
}

/** Largest percentage move between the last two versions, signed; null for a first price. */
const biggestChange = (lines: PriceDiffLine[] | undefined): number | null =>
  (lines ?? []).reduce<number | null>((best, line) => {
    if (line.changePct == null) {
      return best;
    }
    return best == null || Math.abs(line.changePct) > Math.abs(best) ? line.changePct : best;
  }, null);

export function createPriceHandlers(deps: PriceHandlerDeps): PriceHandlers {
  const audit = async (
    req: ServerRequest,
    action: AuditAction,
    modelId: string,
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> => {
    const actor = actorOf(req);
    await deps.recordAuditEntry(
      {
        action,
        severity: 'warning',
        actor: { type: 'user', id: actor.id, name: actor.name },
        target: { type: 'model_price', id: modelId, name: modelId },
        metadata,
        context: buildAuditContext(req),
        tenantId: undefined,
      },
      { failClosed: true },
    );
  };

  const fail = (res: Response, error: unknown, what: string): void => {
    logger.error(`[ModelPrice] ${what} failed`, error);
    res.status(500).json({ error: `Failed to ${what}` });
  };

  async function lastChangeOf(modelId: string): Promise<PriceDiffLine[]> {
    const { ModelPriceVersion } = deps.models();
    const latest = await ModelPriceVersion.findOne({ modelId, previous: { $ne: null } })
      .sort({ version: -1 })
      .lean<IModelPriceVersion>();
    return latest?.diff ?? [];
  }

  function present(doc: IModelPrice, changedDays: number, now: Date) {
    const effective = effectivePrice(doc, now);
    const changedRecently =
      doc.lastChangedAt != null &&
      doc.version > 1 &&
      now.getTime() - doc.lastChangedAt.getTime() <= changedDays * DAY_MS;
    const status: ListStatus = doc.status === 'ok' && changedRecently ? 'changed' : doc.status;
    return {
      modelId: doc.modelId,
      name: doc.name ?? doc.modelId,
      kind: doc.kind,
      usedFor: doc.usedFor,
      status,
      source: effective?.source ?? null,
      price: effective?.price ?? null,
      syncedPrice: doc.price ?? null,
      override: doc.override
        ? {
            reason: doc.override.reason,
            setBy: doc.override.setBy ?? null,
            setAt: doc.override.setAt,
            until: doc.override.until ?? null,
          }
        : null,
      longPrompt: longPrompt(effective?.price),
      contextLength: effective?.price.contextLength ?? null,
      fetchedAt: doc.fetchedAt ?? null,
      lastChangedAt: doc.lastChangedAt ?? null,
      version: doc.version,
      unpricedHits: doc.unpricedHits,
    };
  }

  const list: Handler = async (req, res) => {
    try {
      const { ModelPrice, ModelPriceChange, ModelPriceSync } = deps.models();
      const now = new Date();
      const changedDays = limitOf(req.query?.changedDays, DEFAULT_CHANGED_DAYS);
      const wantedStatus = typeof req.query?.status === 'string' ? req.query.status : undefined;
      const wantedUse = typeof req.query?.use === 'string' ? req.query.use : undefined;
      const docs = await ModelPrice.find({
        $or: [{ usedFor: { $ne: [] } }, { unpricedHits: { $gt: 0 } }],
      }).lean<IModelPrice[]>();
      const rows = docs
        .map((doc) => present(doc, changedDays, now))
        .filter((row) => !wantedStatus || row.status === wantedStatus)
        .filter((row) => !wantedUse || row.usedFor.some((use) => use.startsWith(wantedUse)))
        .sort((a, b) => {
          return (
            STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.modelId.localeCompare(b.modelId)
          );
        });
      const [lastSync, lastGood, unseen] = await Promise.all([
        ModelPriceSync.findOne({}).sort({ startedAt: -1 }).lean<IModelPriceSync>(),
        ModelPriceSync.findOne({ ok: true }).sort({ startedAt: -1 }).lean<IModelPriceSync>(),
        ModelPriceChange.countDocuments({ seenAt: null }),
      ]);
      const failingSince = lastSync && !lastSync.ok ? (lastGood?.startedAt ?? null) : null;
      const failingHours = failingSince
        ? (now.getTime() - failingSince.getTime()) / 3_600_000
        : null;
      const count = (status: ListStatus): number =>
        rows.filter((row) => row.status === status).length;
      res.json({
        lastSync: lastSync ?? null,
        lastSuccessfulSync: lastGood ?? null,
        warnings: {
          noPrice: count('no_price'),
          notListed: count('not_listed'),
          syncFailingOver24h: failingHours != null && failingHours > 24,
        },
        unseenNotices: unseen,
        models: rows,
      });
    } catch (error) {
      fail(res, error, 'list model prices');
    }
  };

  const changes: Handler = async (req, res) => {
    try {
      const { ModelPriceChange } = deps.models();
      const since = dateOf(req.query?.since);
      const seen = req.query?.seen;
      const query: Record<string, unknown> = {};
      if (since) {
        query.createdAt = { $gte: since };
      }
      if (seen === 'true') {
        query.seenAt = { $ne: null };
      } else if (seen === 'false') {
        query.seenAt = null;
      }
      const items = await ModelPriceChange.find(query)
        .sort({ createdAt: -1 })
        .limit(limitOf(req.query?.limit, 50))
        .lean<IModelPriceChange[]>();
      res.json({ changes: items });
    } catch (error) {
      fail(res, error, 'list price changes');
    }
  };

  const detail: Handler = async (req, res) => {
    const modelId = modelIdOf(req);
    if (!modelId) {
      res.status(400).json({ error: 'Invalid model id' });
      return;
    }
    try {
      const { ModelPrice, ModelPriceVersion } = deps.models();
      const doc = await ModelPrice.findOne({ modelId }).lean<IModelPrice>();
      if (!doc) {
        res.status(404).json({ error: 'Model not found' });
        return;
      }
      const now = new Date();
      const versions = await ModelPriceVersion.find({ modelId })
        .sort({ version: -1 })
        .limit(200)
        .lean<IModelPriceVersion[]>();
      const effective = effectivePrice(doc, now);
      const latest = versions[0];
      const effect = effective
        ? await costEffect(modelId, effective.price, latest?.previous ?? null, now)
        : null;
      res.json({
        model: present(doc, DEFAULT_CHANGED_DAYS, now),
        lastChange: await lastChangeOf(modelId),
        biggestChangePct: biggestChange(versions.find((v) => v.previous)?.diff),
        versions,
        costEffect: effect,
      });
    } catch (error) {
      fail(res, error, 'load model price');
    }
  };

  const diff: Handler = async (req, res) => {
    const modelId = modelIdOf(req);
    const from = Number(req.query?.from);
    const to = Number(req.query?.to);
    if (!modelId || !Number.isInteger(from) || !Number.isInteger(to)) {
      res.status(400).json({ error: 'model id, from and to (version numbers) are required' });
      return;
    }
    try {
      const { ModelPriceVersion } = deps.models();
      const [a, b] = await Promise.all([
        ModelPriceVersion.findOne({ modelId, version: from }).lean<IModelPriceVersion>(),
        ModelPriceVersion.findOne({ modelId, version: to }).lean<IModelPriceVersion>(),
      ]);
      if (!a || !b) {
        res.status(404).json({ error: 'Version not found' });
        return;
      }
      res.json({ modelId, from, to, diff: diffPrices(a.price, b.price) });
    } catch (error) {
      fail(res, error, 'diff model prices');
    }
  };

  const markSeen: Handler = async (req, res) => {
    const id = (req.params as { id?: string }).id;
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: 'Invalid change id' });
      return;
    }
    try {
      const { ModelPriceChange } = deps.models();
      const updated = await ModelPriceChange.findOneAndUpdate(
        { _id: id, seenAt: null },
        { $set: { seenAt: new Date(), seenBy: actorOf(req).id ?? actorOf(req).name } },
        { new: true },
      ).lean<IModelPriceChange>();
      if (!updated) {
        const exists = await ModelPriceChange.exists({ _id: id });
        res
          .status(exists ? 200 : 404)
          .json(exists ? { alreadySeen: true } : { error: 'Change not found' });
        return;
      }
      res.json({ change: updated });
    } catch (error) {
      fail(res, error, 'mark price change seen');
    }
  };

  const sync: Handler = async (req, res) => {
    try {
      const actor = actorOf(req);
      const result: SyncResult = await runPriceSync(
        { ...deps.syncDeps(), models: deps.models(), store: deps.store() },
        { trigger: 'manual', actor: actor.id ?? actor.name },
      );
      await audit(req, 'platform.model_prices_synced', '*', {
        ok: result.ok,
        models: result.models,
        changed: result.changed,
        skipped: result.skipped ?? null,
      });
      if (result.skipped) {
        res.status(409).json({ error: 'A sync is already running on another server', result });
        return;
      }
      res.status(result.ok ? 200 : 502).json({ result });
    } catch (error) {
      fail(res, error, 'sync model prices');
    }
  };

  const setOverride: Handler = async (req, res) => {
    const modelId = modelIdOf(req);
    const parsed = overrideBody.safeParse(req.body);
    if (!modelId || !parsed.success) {
      res.status(400).json({
        error: 'A valid model id, price and reason are required',
        details: parsed.success ? undefined : parsed.error.issues,
      });
      return;
    }
    const { price, reason, until } = parsed.data;
    if (until && until.getTime() <= Date.now()) {
      res.status(400).json({ error: 'until must be in the future' });
      return;
    }
    try {
      const actor = actorOf(req);
      const store = deps.store();
      const doc = await store.setOverride(modelId, {
        price: price as PriceBlock,
        reason,
        until,
        actor: actor.id ?? actor.name,
      });
      await audit(req, 'platform.model_price_override_set', modelId, {
        reason,
        prompt: price.prompt,
        completion: price.completion,
        until: until?.toISOString() ?? null,
      });
      await store.refreshTable();
      res.json({ model: present(doc, DEFAULT_CHANGED_DAYS, new Date()) });
    } catch (error) {
      fail(res, error, 'set model price override');
    }
  };

  const clearOverride: Handler = async (req, res) => {
    const modelId = modelIdOf(req);
    if (!modelId) {
      res.status(400).json({ error: 'Invalid model id' });
      return;
    }
    try {
      const actor = actorOf(req);
      const store = deps.store();
      const before = await deps.models().ModelPrice.findOne({ modelId }).lean<IModelPrice>();
      if (!before?.override) {
        res.status(404).json({ error: 'No manual override on this model' });
        return;
      }
      const doc = await store.clearOverride(modelId, actor.id ?? actor.name);
      await audit(req, 'platform.model_price_override_cleared', modelId, {
        previousPrompt: before.override.price.prompt,
        previousCompletion: before.override.price.completion,
      });
      await store.refreshTable();
      res.json({ model: doc ? present(doc, DEFAULT_CHANGED_DAYS, new Date()) : null });
    } catch (error) {
      fail(res, error, 'clear model price override');
    }
  };

  return { list, changes, detail, diff, markSeen, sync, setOverride, clearOverride };
}
