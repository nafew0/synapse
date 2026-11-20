import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createTxMethods,
  createPriceStore,
  clearPriceTable,
  findPrice,
} from '@librechat/data-schemas';
import type { PriceStoreModels, IModelPrice, IModelPriceVersion } from '@librechat/data-schemas';
import type { EModelEndpoint } from 'librechat-data-provider';
import type { CatalogServer } from './catalog.helper';
import type { ModelUses } from './models';
import type { SyncDeps } from './sync';
import { startCatalogServer, setChatPrice, fixtureChat, fixtureEmbeddings } from './catalog.helper';
import { matchModelName, findMatchingPattern } from '~/utils';
import { runPriceSync, FAILURE_NOTICE_MS } from './sync';

const HAIKU = 'anthropic/claude-haiku-5.5';
const LUNA = 'openai/gpt-6-luna';
const EMBED = 'google/gemini-embedding-2';
const DEEPSEEK = 'deepseek/deepseek-v4-flash-0731';
const IMAGE = 'x-ai/grok-imagine-image-2.0';

const uses = (...ids: string[]): ModelUses =>
  new Map(ids.map((id) => [id, new Set([`endpoint:test`])]));

describe('runPriceSync', () => {
  let mongo: MongoMemoryServer;
  let server: CatalogServer;
  let models: PriceStoreModels;
  let store: ReturnType<typeof createPriceStore>;
  let inUse: ModelUses;

  const deps = (extra: Partial<SyncDeps> = {}): SyncDeps => ({
    models,
    store,
    collectModels: async () => inUse,
    catalog: { baseUrl: server.baseUrl, timeoutMs: 2000 },
    lockClient: null,
    ...extra,
  });
  const price = (modelId: string) => models.ModelPrice.findOne({ modelId }).lean<IModelPrice>();
  const versions = (modelId: string) =>
    models.ModelPriceVersion.find({ modelId }).sort({ version: 1 }).lean<IModelPriceVersion[]>();
  const notices = (kind: string) => models.ModelPriceChange.find({ kind }).lean();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    models = {
      ModelPrice: mongoose.models.ModelPrice,
      ModelPriceVersion: mongoose.models.ModelPriceVersion,
      ModelPriceChange: mongoose.models.ModelPriceChange,
      ModelPriceSync: mongoose.models.ModelPriceSync,
    } as unknown as PriceStoreModels;
    store = createPriceStore(models);
    server = await startCatalogServer();
  });

  afterAll(async () => {
    await server.close();
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    clearPriceTable();
    server.mode = 'ok';
    server.hits.length = 0;
    server.chat = fixtureChat();
    server.embeddings = fixtureEmbeddings();
    inUse = uses(HAIKU, LUNA, EMBED, DEEPSEEK);
    await Promise.all(
      ['ModelPrice', 'ModelPriceVersion', 'ModelPriceChange', 'ModelPriceSync', 'Transaction'].map(
        (name) => mongoose.models[name].deleteMany({}),
      ),
    );
  });

  it('stores prices for every model in use, with tiers, and records the run', async () => {
    const result = await runPriceSync(deps(), { trigger: 'startup' });
    expect(result).toEqual({ ok: true, models: 4, changed: 0, created: 4, notListed: 0 });

    const haiku = await price(HAIKU);
    expect(haiku).toMatchObject({
      status: 'ok',
      kind: 'chat',
      version: 1,
      usedFor: ['endpoint:test'],
      aliases: ['anthropic/claude-haiku-5.5-20261007'],
    });
    expect(haiku?.price).toMatchObject({ prompt: 0.1, completion: 0.5, cacheRead: 0.01 });
    expect(haiku?.price?.tiers).toHaveLength(1);
    expect(haiku?.price?.tiers[0]).toMatchObject({ minPromptTokens: 100000, prompt: 0.5 });
    expect((await price(LUNA))?.price?.tiers[0].minPromptTokens).toBe(272000);

    const run = await models.ModelPriceSync.findOne({}).lean();
    expect(run).toMatchObject({
      ok: true,
      trigger: 'startup',
      models: 4,
      changed: 0,
      notListed: 0,
    });
    expect(run?.finishedAt).toBeDefined();
    expect(await models.ModelPrice.countDocuments({})).toBe(4);
    expect(await models.ModelPriceChange.countDocuments({})).toBe(0);
    expect(await versions(HAIKU)).toHaveLength(1);
  });

  it('resolves an embedding model from the embeddings catalog', async () => {
    await runPriceSync(deps());
    const embedding = await price(EMBED);
    expect(embedding).toMatchObject({ kind: 'embedding', status: 'ok' });
    expect(embedding?.price).toMatchObject({ prompt: 0.2, completion: 0 });
    expect(server.hits.sort()).toEqual(['/embeddings/models', '/models']);
  });

  it('creates no new versions when the catalog has not changed', async () => {
    await runPriceSync(deps());
    const before = await price(HAIKU);
    const second = await runPriceSync(deps(), { trigger: 'manual', actor: 'root' });
    expect(second).toMatchObject({ ok: true, changed: 0, created: 0 });
    for (const id of [HAIKU, LUNA, EMBED, DEEPSEEK]) {
      expect(await versions(id)).toHaveLength(1);
    }
    expect(await models.ModelPriceChange.countDocuments({})).toBe(0);
    const after = await price(HAIKU);
    expect(after?.version).toBe(1);
    expect(after?.fetchedAt?.getTime()).toBeGreaterThanOrEqual(before?.fetchedAt?.getTime() ?? 0);
    const runs = await models.ModelPriceSync.find({}).sort({ startedAt: 1 }).lean();
    expect(runs.map((r) => r.trigger)).toEqual(['timer', 'manual']);
    expect(runs[1].actor).toBe('root');
  });

  it('records exactly one new version and one notice when one price changes', async () => {
    await runPriceSync(deps());
    setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
    const result = await runPriceSync(deps(), { trigger: 'manual', actor: 'root' });
    expect(result).toMatchObject({ ok: true, changed: 1, created: 0 });

    const haikuVersions = await versions(HAIKU);
    expect(haikuVersions.map((v) => v.version)).toEqual([1, 2]);
    expect(haikuVersions[1]).toMatchObject({
      source: 'sync_now',
      priceSource: 'openrouter',
      actor: 'root',
    });
    expect(haikuVersions[1].previous?.prompt).toBe(0.1);
    expect(haikuVersions[1].price.prompt).toBe(0.2);
    const promptLine = haikuVersions[1].diff.find((l) => l.field === 'prompt');
    expect(promptLine).toMatchObject({
      previous: 0.1,
      current: 0.2,
      change: 0.1,
      changePct: 100,
      kind: 'changed',
    });

    const changed = await notices('price_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ modelId: HAIKU, version: 2 });
    expect(changed[0].summary).toBe(`${HAIKU}: input $0.1 → $0.2 per 1M (+100%)`);
    expect(changed[0].seenAt ?? null).toBeNull();
    expect(await models.ModelPriceChange.countDocuments({})).toBe(1);

    for (const id of [LUNA, EMBED, DEEPSEEK]) {
      expect(await versions(id)).toHaveLength(1);
      expect((await price(id))?.version).toBe(1);
    }
  });

  it('records a changed tier as a tier diff line', async () => {
    await runPriceSync(deps());
    const haiku = server.chat.data.find((m) => m.id === HAIKU) as {
      pricing: { overrides: Array<Record<string, string>> };
    };
    haiku.pricing.overrides[0].prompt = '0.000001';
    await runPriceSync(deps());
    const latest = (await versions(HAIKU))[1];
    expect(latest.diff.find((l) => l.field === 'tier:100000:prompt')).toMatchObject({
      previous: 0.5,
      current: 1,
      kind: 'changed',
    });
  });

  describe('when OpenRouter fails', () => {
    it('changes nothing and records a failed run', async () => {
      await runPriceSync(deps());
      const priceBefore = await price(HAIKU);
      const tableBefore = findPrice(HAIKU);
      expect(tableBefore).toBeDefined();
      server.mode = 'error';
      const result = await runPriceSync(deps());
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/500/);
      expect(await price(HAIKU)).toEqual(priceBefore);
      expect(await versions(HAIKU)).toHaveLength(1);
      expect(findPrice(HAIKU)?.price).toEqual(tableBefore?.price);
      const last = await models.ModelPriceSync.findOne({}).sort({ startedAt: -1 }).lean();
      expect(last).toMatchObject({ ok: false });
      expect(last?.error).toMatch(/500/);
      expect(await notices('sync_failing')).toHaveLength(0);
    });

    it('opens one sync_failing notice when the last good sync is over 24 hours old', async () => {
      await runPriceSync(deps());
      server.mode = 'error';
      const later = () => new Date(Date.now() + FAILURE_NOTICE_MS + 60_000);
      await runPriceSync(deps({ now: later }));
      await runPriceSync(deps({ now: later }));
      const failing = await notices('sync_failing');
      expect(failing).toHaveLength(1);
      expect(failing[0].modelId).toBe('*');
      expect(failing[0].summary).toMatch(/failed for over 24 hours/);

      server.mode = 'ok';
      await runPriceSync(deps());
      const closed = await notices('sync_failing');
      expect(closed[0].seenAt).toBeTruthy();
      expect(closed[0].seenBy).toBe('system');
    });

    it('opens a notice at once when no sync ever succeeded', async () => {
      server.mode = 'error';
      await runPriceSync(deps());
      expect(await notices('sync_failing')).toHaveLength(1);
      expect(await models.ModelPrice.countDocuments({})).toBe(0);
    });

    it('treats a body that is not a model list as a failure', async () => {
      server.mode = 'garbage';
      const result = await runPriceSync(deps());
      expect(result.ok).toBe(false);
      expect(await models.ModelPrice.countDocuments({})).toBe(0);
    });
  });

  describe('models OpenRouter does not list', () => {
    it('keeps the last price and flags a priced model not_listed once', async () => {
      await runPriceSync(deps());
      server.chat.data = server.chat.data.filter((m) => m.id !== LUNA);
      const first = await runPriceSync(deps());
      const second = await runPriceSync(deps());
      expect(first).toMatchObject({ ok: true, notListed: 1 });
      expect(second.notListed).toBe(1);
      const luna = await price(LUNA);
      expect(luna?.status).toBe('not_listed');
      expect(luna?.price?.prompt).toBe(0.1);
      expect(findPrice(LUNA)?.price.prompt).toBe(0.1);
      expect(await notices('not_listed')).toHaveLength(1);
      expect(await versions(LUNA)).toHaveLength(1);
    });

    it('marks a model that was never priced no_price and opens an unpriced notice', async () => {
      inUse = uses(HAIKU, 'acme/never-listed');
      const result = await runPriceSync(deps());
      expect(result.notListed).toBe(1);
      const doc = await price('acme/never-listed');
      expect(doc).toMatchObject({ status: 'no_price', version: 0 });
      expect(doc?.price).toBeUndefined();
      expect(await notices('unpriced')).toHaveLength(1);
      const run = await models.ModelPriceSync.findOne({}).lean();
      expect(run?.unpriced).toBe(1);
    });

    it('skips UNLISTED_OK models without a notice or a not-listed count', async () => {
      inUse = uses(HAIKU, IMAGE);
      const result = await runPriceSync(deps());
      expect(result).toMatchObject({ ok: true, notListed: 0 });
      expect(await models.ModelPriceChange.countDocuments({})).toBe(0);
      const doc = await price(IMAGE);
      expect(doc?.usedFor).toEqual(['endpoint:test']);
      expect(doc?.status).toBe('no_price');
    });
  });

  describe('billing reads the synced table', () => {
    const { getMultiplier, getCacheMultiplier } = createTxMethods(mongoose, {
      matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
      findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
    });

    it('uses the synced rate and its long-prompt tier at 100000 tokens', async () => {
      await runPriceSync(deps());
      const rate = (tokens: number, tokenType: 'prompt' | 'completion') =>
        getMultiplier({ model: HAIKU, tokenType, inputTokenCount: tokens });
      expect(rate(1000, 'prompt')).toBe(0.1);
      expect(rate(99999, 'prompt')).toBe(0.1);
      expect(rate(100000, 'prompt')).toBe(0.5);
      expect(rate(100000, 'completion')).toBe(2.5);
      expect(rate(1000, 'completion')).toBe(0.5);
      expect(getCacheMultiplier({ model: HAIKU, cacheType: 'read', inputTokenCount: 1000 })).toBe(
        0.01,
      );
      expect(getCacheMultiplier({ model: HAIKU, cacheType: 'read', inputTokenCount: 100000 })).toBe(
        0.05,
      );
      expect(
        getMultiplier({ model: 'anthropic/claude-haiku-5.5-20261007', tokenType: 'prompt' }),
      ).toBe(0.1);
      expect(getMultiplier({ model: EMBED, tokenType: 'prompt' })).toBe(0.2);
    });

    it('moves the billed rate when a sync changes the price', async () => {
      await runPriceSync(deps());
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000003' });
      await runPriceSync(deps());
      expect(getMultiplier({ model: HAIKU, tokenType: 'prompt', inputTokenCount: 10 })).toBe(0.3);
    });

    it('keeps a manual override winning over a later sync', async () => {
      await runPriceSync(deps());
      await store.setOverride(HAIKU, {
        price: { prompt: 9, completion: 18, tiers: [] },
        reason: 'contract rate',
        actor: 'root',
      });
      await store.refreshTable();
      expect(getMultiplier({ model: HAIKU, tokenType: 'prompt', inputTokenCount: 1000 })).toBe(9);

      setChatPrice(server.chat, HAIKU, { prompt: '0.0000004' });
      await runPriceSync(deps());
      const doc = await price(HAIKU);
      expect(doc?.price?.prompt).toBe(0.4);
      expect(doc?.override?.price.prompt).toBe(9);
      expect(getMultiplier({ model: HAIKU, tokenType: 'prompt', inputTokenCount: 1000 })).toBe(9);
      expect(getMultiplier({ model: HAIKU, tokenType: 'prompt', inputTokenCount: 200000 })).toBe(9);
      const latest = (await versions(HAIKU)).pop();
      expect(latest?.source).toBe('sync');
      expect(latest?.note).toMatch(/manual override/);

      await store.clearOverride(HAIKU, 'root');
      await store.refreshTable();
      expect(getMultiplier({ model: HAIKU, tokenType: 'prompt', inputTokenCount: 1000 })).toBe(0.4);
    });
  });

  describe('locking', () => {
    it('lets only one of two concurrent syncs run when they share a lock', async () => {
      const store1 = new Map<string, string>();
      const lockClient = {
        set: async (key: string, value: string) => {
          if (store1.has(key)) {
            return null;
          }
          store1.set(key, value);
          return 'OK';
        },
        eval: async (_s: string, _k: number, key: string, value: string) => {
          if (store1.get(key) === value) {
            store1.delete(key);
            return 1;
          }
          return 0;
        },
      };
      const results = await Promise.all([
        runPriceSync(deps({ lockClient })),
        runPriceSync(deps({ lockClient })),
      ]);
      const skipped = results.filter((r) => r.skipped === 'locked');
      const ran = results.filter((r) => !r.skipped);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ ok: false, models: 0 });
      expect(ran).toHaveLength(1);
      expect(ran[0].ok).toBe(true);
      expect(await models.ModelPriceSync.countDocuments({})).toBe(1);
      expect(store1.size).toBe(0);

      const again = await runPriceSync(deps({ lockClient }));
      expect(again.skipped).toBeUndefined();
    });

    it('releases the lock after a failed run', async () => {
      const held = new Map<string, string>();
      const lockClient = {
        set: async (key: string, value: string) =>
          held.has(key) ? null : (held.set(key, value), 'OK'),
        eval: async (_s: string, _k: number, key: string, value: string) =>
          held.get(key) === value ? (held.delete(key), 1) : 0,
      };
      server.mode = 'error';
      const failed = await runPriceSync(deps({ lockClient }));
      expect(failed.ok).toBe(false);
      expect(held.size).toBe(0);
    });
  });
});
