import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createPriceStore,
  clearPriceTable,
  findPrice,
} from '@librechat/data-schemas';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import type { PriceStoreModels, IModelPrice } from '@librechat/data-schemas';
import type { CatalogServer } from './catalog.helper';
import type { RedisLockClient } from './lock';
import type { ModelUses } from './models';
import { startCatalogServer, setChatPrice, fixtureChat, fixtureEmbeddings } from './catalog.helper';
import { createPriceHandlers } from './handlers';
import { runPriceSync } from './sync';

const HAIKU = 'anthropic/claude-haiku-5.5';
const LUNA = 'openai/gpt-6-luna';
const ENC_HAIKU = encodeURIComponent(HAIKU);
const DAY = 24 * 60 * 60 * 1000;

describe('price handlers', () => {
  let mongo: MongoMemoryServer;
  let server: CatalogServer;
  let models: PriceStoreModels;
  let store: ReturnType<typeof createPriceStore>;
  let app: Express;
  let inUse: ModelUses;
  let lockClient: RedisLockClient | null;
  let actingId = 'root-1';
  const recordAuditEntry = jest.fn().mockResolvedValue(undefined);

  const syncDeps = () => ({
    models,
    store,
    collectModels: async () => inUse,
    catalog: { baseUrl: server.baseUrl, timeoutMs: 2000 },
    lockClient: null,
  });
  const sync = (trigger: 'timer' | 'manual' = 'timer') => runPriceSync(syncDeps(), { trigger });

  const buildApp = (): Express => {
    const handlers = createPriceHandlers({
      models: () => models,
      store: () => store,
      syncDeps: () => ({
        collectModels: async () => inUse,
        catalog: { baseUrl: server.baseUrl, timeoutMs: 2000 },
        lockClient,
      }),
      recordAuditEntry,
    });
    const instance = express();
    instance.use(express.json());
    instance.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: { id: string; name: string } }).user = {
        id: actingId,
        name: 'Root Admin',
      };
      next();
    });
    instance.get('/', handlers.list as unknown as RequestHandler);
    instance.get('/changes', handlers.changes as unknown as RequestHandler);
    instance.post('/changes/:id/seen', handlers.markSeen as unknown as RequestHandler);
    instance.post('/sync', handlers.sync as unknown as RequestHandler);
    instance.get('/:modelId/diff', handlers.diff as unknown as RequestHandler);
    instance.put('/:modelId/override', handlers.setOverride as unknown as RequestHandler);
    instance.delete('/:modelId/override', handlers.clearOverride as unknown as RequestHandler);
    instance.get('/:modelId', handlers.detail as unknown as RequestHandler);
    return instance;
  };

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
    app = buildApp();
  });

  afterAll(async () => {
    await server.close();
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    clearPriceTable();
    recordAuditEntry.mockClear();
    lockClient = null;
    actingId = 'root-1';
    server.mode = 'ok';
    server.chat = fixtureChat();
    server.embeddings = fixtureEmbeddings();
    inUse = new Map([
      [HAIKU, new Set(['endpoint:OpenRouter', 'spec:fast'])],
      [LUNA, new Set(['agent'])],
      ['google/gemini-embedding-2', new Set(['memory'])],
    ]);
    await Promise.all(
      ['ModelPrice', 'ModelPriceVersion', 'ModelPriceChange', 'ModelPriceSync', 'Transaction'].map(
        (name) => mongoose.models[name].deleteMany({}),
      ),
    );
  });

  describe('GET / (list)', () => {
    it('lists models with source, price, long-prompt note and sync info', async () => {
      await sync();
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(3);
      const haiku = res.body.models.find((m: { modelId: string }) => m.modelId === HAIKU);
      expect(haiku).toMatchObject({
        status: 'ok',
        source: 'openrouter',
        kind: 'chat',
        override: null,
        version: 1,
        longPrompt: '×5 above 100,000 tokens',
        contextLength: 1000000,
      });
      expect(haiku.usedFor.sort()).toEqual(['endpoint:OpenRouter', 'spec:fast']);
      expect(haiku.price.prompt).toBe(0.1);
      expect(res.body.lastSync.ok).toBe(true);
      expect(res.body.lastSuccessfulSync.ok).toBe(true);
      expect(res.body.warnings).toEqual({ noPrice: 0, notListed: 0, syncFailingOver24h: false });
      expect(res.body.unseenNotices).toBe(0);
    });

    it('shows a recent price change as "changed" and an old one as ok', async () => {
      await sync();
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
      await sync();
      const find = (body: { models: Array<{ modelId: string; status: string }> }) =>
        body.models.find((m) => m.modelId === HAIKU)?.status;
      const fresh = await request(app).get('/');
      expect(find(fresh.body)).toBe('changed');
      expect(fresh.body.unseenNotices).toBe(1);

      await models.ModelPrice.updateOne(
        { modelId: HAIKU },
        { $set: { lastChangedAt: new Date(Date.now() - 10 * DAY) } },
      );
      expect(find((await request(app).get('/')).body)).toBe('ok');
      expect(find((await request(app).get('/?changedDays=30')).body)).toBe('changed');
    });

    it('does not badge a first price as changed', async () => {
      await sync();
      const res = await request(app).get('/?status=changed');
      expect(res.body.models).toEqual([]);
    });

    it('orders by urgency, filters by status and use, and counts warnings', async () => {
      await sync();
      server.chat.data = server.chat.data.filter((m) => m.id !== LUNA);
      inUse.set('acme/never-listed', new Set(['title']));
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
      await sync();
      const res = await request(app).get('/');
      expect(res.body.models.map((m: { status: string }) => m.status)).toEqual([
        'no_price',
        'not_listed',
        'changed',
        'ok',
      ]);
      expect(res.body.warnings).toMatchObject({ noPrice: 1, notListed: 1 });
      const notListed = res.body.models.find((m: { modelId: string }) => m.modelId === LUNA);
      expect(notListed.price.prompt).toBe(0.1);

      const byStatus = await request(app).get('/?status=not_listed');
      expect(byStatus.body.models.map((m: { modelId: string }) => m.modelId)).toEqual([LUNA]);
      const byUse = await request(app).get('/?use=endpoint');
      expect(byUse.body.models.map((m: { modelId: string }) => m.modelId)).toEqual([HAIKU]);
    });

    it('lists a model that was only billed unpriced, and hides unused ones', async () => {
      await store.recordUnpriced('acme/mystery', 'unknown');
      await models.ModelPrice.create({ modelId: 'acme/idle', usedFor: [], unpricedHits: 0 });
      const res = await request(app).get('/');
      expect(res.body.models.map((m: { modelId: string }) => m.modelId)).toEqual(['acme/mystery']);
      expect(res.body.models[0]).toMatchObject({
        status: 'no_price',
        unpricedHits: 1,
        price: null,
      });
    });

    it('flags a sync that has been failing for over 24 hours', async () => {
      await sync();
      await models.ModelPriceSync.updateMany(
        {},
        { $set: { startedAt: new Date(Date.now() - 2 * DAY) } },
      );
      server.mode = 'error';
      await sync();
      const res = await request(app).get('/');
      expect(res.body.warnings.syncFailingOver24h).toBe(true);
      expect(res.body.lastSync.ok).toBe(false);
      expect(res.body.lastSuccessfulSync.ok).toBe(true);
    });

    it('does not flag a failure shorter than 24 hours', async () => {
      await sync();
      server.mode = 'error';
      await sync();
      const res = await request(app).get('/');
      expect(res.body.warnings.syncFailingOver24h).toBe(false);
    });
  });

  describe('changes and seen', () => {
    it('lists notices, filters by seen and since, and marks one seen', async () => {
      await sync();
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
      setChatPrice(server.chat, LUNA, { prompt: '0.0000003' });
      await sync();
      const all = await request(app).get('/changes');
      expect(all.status).toBe(200);
      expect(all.body.changes).toHaveLength(2);

      const target = all.body.changes[0];
      const marked = await request(app).post(`/changes/${target._id}/seen`);
      expect(marked.status).toBe(200);
      expect(marked.body.change.seenAt).toBeTruthy();
      expect(marked.body.change.seenBy).toBe('root-1');

      const unseen = await request(app).get('/changes?seen=false');
      expect(unseen.body.changes).toHaveLength(1);
      expect(unseen.body.changes[0]._id).not.toBe(target._id);
      const seen = await request(app).get('/changes?seen=true');
      expect(seen.body.changes.map((c: { _id: string }) => c._id)).toEqual([target._id]);

      const future = new Date(Date.now() + DAY).toISOString();
      expect((await request(app).get(`/changes?since=${future}`)).body.changes).toEqual([]);
      expect((await request(app).get('/changes?limit=1')).body.changes).toHaveLength(1);

      const again = await request(app).post(`/changes/${target._id}/seen`);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ alreadySeen: true });
    });

    it('rejects a bad change id and 404s an unknown one', async () => {
      expect((await request(app).post('/changes/not-an-id/seen')).status).toBe(400);
      const unknown = new mongoose.Types.ObjectId().toString();
      expect((await request(app).post(`/changes/${unknown}/seen`)).status).toBe(404);
    });
  });

  describe('GET /:modelId (detail) and cost effect', () => {
    const seedRow = (row: Record<string, unknown>) =>
      mongoose.models.Transaction.create({
        user: new mongoose.Types.ObjectId(),
        conversationId: 'c1',
        model: HAIKU,
        ...row,
      });

    it('returns versions, last change and the biggest move for an encoded model id', async () => {
      await sync();
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
      await sync();
      const res = await request(app).get(`/${ENC_HAIKU}`);
      expect(res.status).toBe(200);
      expect(res.body.model).toMatchObject({ modelId: HAIKU, version: 2, status: 'changed' });
      expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(
        res.body.lastChange.find((l: { field: string }) => l.field === 'prompt'),
      ).toMatchObject({
        previous: 0.1,
        current: 0.2,
      });
      expect(res.body.biggestChangePct).toBe(100);
      expect(res.body.costEffect).toMatchObject({ windowDays: 30, calls: 0, truncated: false });
    });

    it('computes cost effect from the ledger, pairing completions to their prompt tier', async () => {
      await sync();
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002', completion: '0.000001' });
      const haiku = server.chat.data.find((m) => m.id === HAIKU) as {
        pricing: { overrides: Array<Record<string, string>> };
      };
      haiku.pricing.overrides[0].completion = '0.000004';
      await sync();

      await seedRow({ requestKey: 'a', tokenType: 'prompt', rawAmount: -1000, tokenValue: -100 });
      await seedRow({
        requestKey: 'a',
        tokenType: 'completion',
        rawAmount: -500,
        tokenValue: -250,
      });
      await seedRow({
        requestKey: 'b',
        tokenType: 'prompt',
        inputTokens: -100000,
        readTokens: -50000,
        writeTokens: 0,
        tokenValue: -52500,
      });
      await seedRow({
        requestKey: 'b',
        tokenType: 'completion',
        rawAmount: -1000,
        tokenValue: -2500,
      });
      await seedRow({
        requestKey: 'old',
        tokenType: 'prompt',
        rawAmount: -9_000_000,
        tokenValue: -1,
        createdAt: new Date(Date.now() - 40 * DAY),
      });
      await seedRow({
        requestKey: 'other',
        model: LUNA,
        tokenType: 'prompt',
        rawAmount: -5000,
        tokenValue: -1,
      });

      const res = await request(app).get(`/${ENC_HAIKU}`);
      expect(res.status).toBe(200);
      expect(res.body.costEffect).toEqual({
        windowDays: 30,
        calls: 2,
        truncated: false,
        recordedUsd: 0.05535,
        atPreviousUsd: 0.05535,
        atCurrentUsd: 0.0572,
        differenceUsd: 0.00185,
      });
    });

    it('400s an invalid id and 404s an unknown model', async () => {
      expect((await request(app).get('/bad%20id')).status).toBe(400);
      expect((await request(app).get('/acme%2Fnone')).status).toBe(404);
    });
  });

  describe('GET /:modelId/diff', () => {
    it('diffs two versions and rejects bad input', async () => {
      await sync();
      setChatPrice(server.chat, HAIKU, { prompt: '0.0000002' });
      await sync();
      const res = await request(app).get(`/${ENC_HAIKU}/diff?from=1&to=2`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ modelId: HAIKU, from: 1, to: 2 });
      const prompt = res.body.diff.find((l: { field: string }) => l.field === 'prompt');
      expect(prompt).toMatchObject({ previous: 0.1, current: 0.2, kind: 'changed' });
      const completion = res.body.diff.find((l: { field: string }) => l.field === 'completion');
      expect(completion.kind).toBe('unchanged');

      expect((await request(app).get(`/${ENC_HAIKU}/diff?from=1`)).status).toBe(400);
      expect((await request(app).get(`/${ENC_HAIKU}/diff?from=1&to=x`)).status).toBe(400);
      expect((await request(app).get(`/${ENC_HAIKU}/diff?from=1&to=9`)).status).toBe(404);
    });
  });

  describe('POST /sync', () => {
    it('runs a manual sync, answers 200 and writes an audit entry', async () => {
      const res = await request(app).post('/sync');
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ ok: true, models: 3, created: 3 });
      const run = await models.ModelPriceSync.findOne({}).lean();
      expect(run).toMatchObject({ trigger: 'manual', actor: 'root-1' });
      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      const [input, options] = recordAuditEntry.mock.calls[0];
      expect(input).toMatchObject({
        action: 'platform.model_prices_synced',
        actor: { type: 'user', id: 'root-1', name: 'Root Admin' },
        target: { type: 'model_price', id: '*' },
        metadata: { ok: true, models: 3, changed: 0, skipped: null },
      });
      expect(options).toEqual({ failClosed: true });
      expect(findPrice(HAIKU)).toBeDefined();
    });

    it('answers 409 when another server holds the lock', async () => {
      lockClient = {
        set: async () => null,
        eval: async () => 0,
      };
      const res = await request(app).post('/sync');
      expect(res.status).toBe(409);
      expect(res.body.result.skipped).toBe('locked');
      expect(await models.ModelPriceSync.countDocuments({})).toBe(0);
      expect(recordAuditEntry.mock.calls[0][0].metadata).toMatchObject({
        ok: false,
        skipped: 'locked',
      });
    });

    it('answers 502 when OpenRouter fails and keeps the prices', async () => {
      await request(app).post('/sync');
      server.mode = 'error';
      const res = await request(app).post('/sync');
      expect(res.status).toBe(502);
      expect(res.body.result).toMatchObject({ ok: false });
      expect(res.body.result.error).toMatch(/500/);
      expect(res.body.error).toMatch(/OpenRouter.*500/);
      expect((await models.ModelPrice.findOne({ modelId: HAIKU }).lean())?.price?.prompt).toBe(0.1);
    });

    it('keeps URLs, long tokens and stack traces out of the 502 error string', async () => {
      const res = await request(app)
        .post('/sync')
        .send()
        .then(async () => {
          const failing = createPriceHandlers({
            models: () => models,
            store: () => store,
            syncDeps: () => ({
              collectModels: async () => {
                throw new Error(
                  `fetch https://openrouter.ai/api/v1/models?key=sk-or-v1-${'a'.repeat(40)} failed\n    at run (file.js:1:1)`,
                );
              },
              lockClient: null,
            }),
            recordAuditEntry,
          });
          const failApp = express();
          failApp.post('/sync', failing.sync as unknown as RequestHandler);
          return request(failApp).post('/sync');
        });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('fetch [url] failed at run (file.js:1:1)');
      expect(res.body.error).not.toMatch(/sk-or|https?:/);
    });
  });

  describe('actor names', () => {
    const body = { price: { prompt: 9, completion: 18 }, reason: 'contract rate' };

    it('resolves override and version actors to a name in one user query', async () => {
      const User = mongoose.models.User;
      const admin = await User.create({
        name: 'Ada Admin',
        email: 'ada@example.com',
        username: 'ada',
        provider: 'local',
      });
      await sync();
      actingId = String(admin._id);
      await request(app).put(`/${ENC_HAIKU}/override`).send(body);
      const findSpy = jest.spyOn(User, 'find');

      const detail = await request(app).get(`/${ENC_HAIKU}`);
      expect(detail.body.model.override).toMatchObject({
        setBy: String(admin._id),
        setByName: 'Ada Admin',
      });
      const manual = detail.body.versions.find(
        (v: { source: string }) => v.source === 'override_set',
      );
      expect(manual).toMatchObject({ actor: String(admin._id), actorName: 'Ada Admin' });
      const automatic = detail.body.versions.find((v: { source: string }) => v.source === 'sync');
      expect(automatic.actorName).toBeNull();
      expect(findSpy).toHaveBeenCalledTimes(1);

      const list = await request(app).get('/');
      const row = list.body.models.find((m: { modelId: string }) => m.modelId === HAIKU);
      expect(row.override).toMatchObject({ setBy: String(admin._id), setByName: 'Ada Admin' });
      findSpy.mockRestore();
      await User.deleteMany({});
    });

    it('gives null for a deleted user and passes a plain-name actor through', async () => {
      await sync();
      actingId = String(new mongoose.Types.ObjectId());
      await request(app).put(`/${ENC_HAIKU}/override`).send(body);
      const gone = await request(app).get(`/${ENC_HAIKU}`);
      expect(gone.body.model.override.setByName).toBeNull();

      await models.ModelPrice.updateOne(
        { modelId: HAIKU },
        { 'override.setBy': 'platform-superadmin' },
      );
      const named = await request(app).get(`/${ENC_HAIKU}`);
      expect(named.body.model.override.setByName).toBe('platform-superadmin');
    });
  });

  describe('override set and clear', () => {
    const body = { price: { prompt: 9, completion: 18 }, reason: 'contract rate' };

    beforeEach(async () => {
      await sync();
    });

    it('sets an override, audits it, and billing follows at once', async () => {
      const res = await request(app).put(`/${ENC_HAIKU}/override`).send(body);
      expect(res.status).toBe(200);
      expect(res.body.model).toMatchObject({
        modelId: HAIKU,
        source: 'manual',
        override: { reason: 'contract rate', setBy: 'root-1', until: null },
      });
      expect(res.body.model.syncedPrice.prompt).toBe(0.1);
      expect(res.body.model.price.prompt).toBe(9);
      expect(findPrice(HAIKU)?.price.prompt).toBe(9);
      expect(findPrice(HAIKU)?.source).toBe('manual');
      const versions = await models.ModelPriceVersion.find({ modelId: HAIKU })
        .sort({ version: 1 })
        .lean();
      expect(versions.map((v) => v.source)).toEqual(['sync', 'override_set']);

      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      const [input, options] = recordAuditEntry.mock.calls[0];
      expect(input).toMatchObject({
        action: 'platform.model_price_override_set',
        severity: 'warning',
        target: { type: 'model_price', id: HAIKU, name: HAIKU },
        metadata: { reason: 'contract rate', prompt: 9, completion: 18, until: null },
      });
      expect(options).toEqual({ failClosed: true });
    });

    it('accepts a future until and stores it', async () => {
      const until = new Date(Date.now() + 5 * DAY).toISOString();
      const res = await request(app)
        .put(`/${ENC_HAIKU}/override`)
        .send({ ...body, until });
      expect(res.status).toBe(200);
      expect(new Date(res.body.model.override.until).toISOString()).toBe(until);
      expect(recordAuditEntry.mock.calls[0][0].metadata.until).toBe(until);
    });

    it.each([
      ['a missing reason', { price: body.price }],
      ['a too short reason', { ...body, reason: 'x' }],
      ['a negative price', { ...body, price: { prompt: -1, completion: 1 } }],
      ['a missing price', { reason: 'contract rate' }],
      [
        'a bad tier',
        {
          ...body,
          price: { ...body.price, tiers: [{ minPromptTokens: 0, prompt: 1, completion: 1 }] },
        },
      ],
    ])('rejects %s with 400', async (_label, payload) => {
      const res = await request(app).put(`/${ENC_HAIKU}/override`).send(payload);
      expect(res.status).toBe(400);
      expect(recordAuditEntry).not.toHaveBeenCalled();
      expect(
        (await models.ModelPrice.findOne({ modelId: HAIKU }).lean())?.override ?? null,
      ).toBeNull();
    });

    it('rejects an until in the past', async () => {
      const until = new Date(Date.now() - 1000).toISOString();
      const res = await request(app)
        .put(`/${ENC_HAIKU}/override`)
        .send({ ...body, until });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/future/);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('rejects an invalid model id', async () => {
      expect((await request(app).put('/bad%20id/override').send(body)).status).toBe(400);
    });

    it('404s clearing when there is no override', async () => {
      const res = await request(app).delete(`/${ENC_HAIKU}/override`);
      expect(res.status).toBe(404);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('clears an override, restores the synced price and audits it', async () => {
      await request(app).put(`/${ENC_HAIKU}/override`).send(body);
      recordAuditEntry.mockClear();
      const res = await request(app).delete(`/${ENC_HAIKU}/override`);
      expect(res.status).toBe(200);
      expect(res.body.model).toMatchObject({ source: 'openrouter', override: null });
      expect(findPrice(HAIKU)?.price.prompt).toBe(0.1);
      const [input] = recordAuditEntry.mock.calls[0];
      expect(input).toMatchObject({
        action: 'platform.model_price_override_cleared',
        target: { id: HAIKU },
        metadata: { previousPrompt: 9, previousCompletion: 18 },
      });
      const doc = await models.ModelPrice.findOne({ modelId: HAIKU }).lean<IModelPrice>();
      expect(doc?.version).toBe(3);
    });
  });
});
