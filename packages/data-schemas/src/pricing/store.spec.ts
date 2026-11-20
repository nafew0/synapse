import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { IModelPrice, PriceBlock } from '~/types/modelPrice';
import type { PriceStore } from './store';
import {
  createModelPriceModel,
  createModelPriceSyncModel,
  createModelPriceChangeModel,
  createModelPriceVersionModel,
} from '~/models/modelPrice';
import { clearPriceTable, findPrice, setUnpricedSink } from './table';
import { createPriceStore, effectivePrice } from './store';

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let store: PriceStore;
let ModelPrice: Model<IModelPrice>;
const ModelPriceVersion = createModelPriceVersionModel(mongoose);
const ModelPriceChange = createModelPriceChangeModel(mongoose);
const ModelPriceSync = createModelPriceSyncModel(mongoose);

const price = (
  prompt: number,
  completion: number,
  extra: Partial<PriceBlock> = {},
): PriceBlock => ({
  prompt,
  completion,
  tiers: [],
  ...extra,
});
const listed = (modelId: string, block: PriceBlock, aliases: string[] = []) => ({
  modelId,
  aliases,
  kind: 'chat' as const,
  price: block,
});
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-02T00:00:00Z');
const sync = { at: t0, source: 'sync' as const };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ModelPrice = createModelPriceModel(mongoose);
  await Promise.all([
    ModelPrice.init(),
    ModelPriceVersion.init(),
    ModelPriceChange.init(),
    ModelPriceSync.init(),
  ]);
  store = createPriceStore({ ModelPrice, ModelPriceVersion, ModelPriceChange, ModelPriceSync });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  clearPriceTable();
  setUnpricedSink(null);
  await Promise.all([
    ModelPrice.deleteMany({}),
    ModelPriceVersion.deleteMany({}),
    ModelPriceChange.deleteMany({}),
    ModelPriceSync.deleteMany({}),
  ]);
});

describe('applyListed', () => {
  it('first price creates version 1 and no notice', async () => {
    const result = await store.applyListed(listed('a/m', price(1, 2)), sync);
    expect(result).toEqual({ created: true, changed: false });
    const doc = await ModelPrice.findOne({ modelId: 'a/m' }).lean();
    expect(doc).toMatchObject({ version: 1, status: 'ok', kind: 'chat' });
    expect(await ModelPriceVersion.countDocuments({ modelId: 'a/m' })).toBe(1);
    expect(await ModelPriceChange.countDocuments()).toBe(0);
  });

  it('the same price only moves fetchedAt', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    const result = await store.applyListed(listed('a/m', price(1, 2)), { ...sync, at: t1 });
    expect(result).toEqual({ created: false, changed: false });
    const doc = await ModelPrice.findOne({ modelId: 'a/m' }).lean();
    expect(doc?.version).toBe(1);
    expect(doc?.fetchedAt?.toISOString()).toBe(t1.toISOString());
    expect(doc?.lastChangedAt?.toISOString()).toBe(t0.toISOString());
    expect(await ModelPriceVersion.countDocuments()).toBe(1);
    expect(await ModelPriceChange.countDocuments()).toBe(0);
  });

  it('a changed price creates version 2 and one notice, leaving other models alone', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    await store.applyListed(listed('b/n', price(5, 6)), sync);
    const result = await store.applyListed(listed('a/m', price(1, 3)), { ...sync, at: t1 });
    expect(result).toEqual({ created: false, changed: true });

    const doc = await ModelPrice.findOne({ modelId: 'a/m' }).lean();
    expect(doc).toMatchObject({ version: 2, price: expect.objectContaining({ completion: 3 }) });
    const v2 = await ModelPriceVersion.findOne({ modelId: 'a/m', version: 2 }).lean();
    expect(v2?.previous?.completion).toBe(2);
    const changes = await ModelPriceChange.find({}).lean();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ modelId: 'a/m', kind: 'price_changed', version: 2 });
    const completion = changes[0].diff.find((line) => line.field === 'completion');
    expect(completion).toMatchObject({ kind: 'changed', previous: 2, current: 3, changePct: 50 });
    expect(changes[0].summary).toContain('output $2 → $3');

    const other = await ModelPrice.findOne({ modelId: 'b/n' }).lean();
    expect(other?.version).toBe(1);
    expect(await ModelPriceVersion.countDocuments({ modelId: 'b/n' })).toBe(1);
  });

  it('notes a live manual override on the new version', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    await store.setOverride('a/m', { price: price(9, 9), reason: 'test' }, t0);
    await store.applyListed(listed('a/m', price(1, 3)), { ...sync, at: t1 });
    const v = await ModelPriceVersion.findOne({
      modelId: 'a/m',
      priceSource: 'openrouter',
      version: 3,
    }).lean();
    expect(v?.note).toMatch(/override is active/);
  });
});

describe('markNotListed / recordUnpriced', () => {
  it('keeps the last price, sets not_listed and opens one notice', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    expect(await store.markNotListed('a/m', t1)).toBe(true);
    expect(await store.markNotListed('a/m', t1)).toBe(false);
    const doc = await ModelPrice.findOne({ modelId: 'a/m' }).lean();
    expect(doc).toMatchObject({
      status: 'not_listed',
      price: expect.objectContaining({ prompt: 1 }),
    });
    const open = await ModelPriceChange.find({ kind: 'not_listed' }).lean();
    expect(open).toHaveLength(1);
  });

  it('a model never priced becomes no_price with an unpriced notice', async () => {
    await store.markNotListed('z/z', t1, ['title']);
    const doc = await ModelPrice.findOne({ modelId: 'z/z' }).lean();
    expect(doc).toMatchObject({ status: 'no_price', usedFor: ['title'] });
    expect(await ModelPriceChange.countDocuments({ modelId: 'z/z', kind: 'unpriced' })).toBe(1);
  });

  it('recordUnpriced counts hits and opens one notice only for unknown', async () => {
    await store.recordUnpriced('q/q', 'unknown');
    await store.recordUnpriced('q/q', 'unknown');
    await store.recordUnpriced('f/f', 'fallback');
    const q = await ModelPrice.findOne({ modelId: 'q/q' }).lean();
    expect(q).toMatchObject({ unpricedHits: 2, status: 'no_price' });
    expect(await ModelPriceChange.countDocuments({ modelId: 'q/q' })).toBe(1);
    expect((await ModelPrice.findOne({ modelId: 'f/f' }).lean())?.unpricedHits).toBe(1);
    expect(await ModelPriceChange.countDocuments({ modelId: 'f/f' })).toBe(0);
  });
});

describe('overrides', () => {
  it('setOverride and clearOverride bump versions and write history', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    const set = await store.setOverride(
      'a/m',
      { price: price(10, 20), reason: 'negotiated', actor: 'root' },
      t1,
    );
    expect(set.version).toBe(2);
    expect(set.override?.reason).toBe('negotiated');
    const v2 = await ModelPriceVersion.findOne({ modelId: 'a/m', version: 2 }).lean();
    expect(v2).toMatchObject({ source: 'override_set', priceSource: 'manual', actor: 'root' });
    expect(v2?.previous?.prompt).toBe(1);

    const cleared = await store.clearOverride('a/m', 'root', t1);
    expect(cleared?.version).toBe(3);
    expect(cleared?.override).toBeNull();
    const v3 = await ModelPriceVersion.findOne({ modelId: 'a/m', version: 3 }).lean();
    expect(v3).toMatchObject({ source: 'override_cleared', priceSource: 'openrouter' });
    expect(v3?.price.prompt).toBe(1);
    expect(v3?.previous?.prompt).toBe(10);
  });

  it('clearOverride without an override is a no-op', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    const doc = await store.clearOverride('a/m');
    expect(doc?.version).toBe(1);
    expect(await ModelPriceVersion.countDocuments()).toBe(1);
  });

  it('override on an unsynced model creates it', async () => {
    const doc = await store.setOverride('n/new', { price: price(1, 1), reason: 'r' });
    expect(doc).toMatchObject({ modelId: 'n/new', version: 1, status: 'ok' });
  });

  it('refreshTable loads synced, manual wins, clear restores synced', async () => {
    await store.applyListed(listed('a/m', price(1, 2), ['a/m-alias']), sync);
    expect(await store.refreshTable()).toBe(1);
    expect(findPrice('a/m')).toMatchObject({ source: 'openrouter' });
    expect(findPrice('a/m-alias')?.price.prompt).toBe(1);

    await store.setOverride('a/m', { price: price(10, 20), reason: 'r' });
    await store.refreshTable();
    expect(findPrice('a/m')).toMatchObject({ source: 'manual' });
    expect(findPrice('a/m')?.price.prompt).toBe(10);

    await store.clearOverride('a/m');
    await store.refreshTable();
    expect(findPrice('a/m')).toMatchObject({ source: 'openrouter' });
    expect(findPrice('a/m')?.price.prompt).toBe(1);
  });

  it('an expired override is ignored by effectivePrice and refreshTable', async () => {
    await store.applyListed(listed('a/m', price(1, 2)), sync);
    await store.setOverride(
      'a/m',
      { price: price(10, 20), reason: 'r', until: new Date(Date.now() - 1000) },
      new Date(Date.now() - 100000),
    );
    const doc = await ModelPrice.findOne({ modelId: 'a/m' }).lean<IModelPrice>();
    expect(effectivePrice(doc as IModelPrice)).toMatchObject({ source: 'openrouter' });
    await store.refreshTable();
    expect(findPrice('a/m')).toMatchObject({ source: 'openrouter' });
  });

  it('refreshTable skips models with no price', async () => {
    await store.markNotListed('z/z', t1);
    expect(await store.refreshTable()).toBe(0);
  });
});

describe('sync runs', () => {
  it('startSync and finishSync record the run', async () => {
    const run = await store.startSync('manual', 'root');
    await store.finishSync(run._id, { ok: true, models: 3, changed: 1 });
    const doc = await ModelPriceSync.findById(run._id).lean();
    expect(doc).toMatchObject({ trigger: 'manual', ok: true, models: 3, changed: 1 });
    expect(doc?.finishedAt).toBeInstanceOf(Date);
  });
});
