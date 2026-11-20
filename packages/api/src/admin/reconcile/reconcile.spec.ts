/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON bodies in endpoint assertions */
import mongoose from 'mongoose';
import { createServer } from 'http';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { ServerRequest } from '~/types/http';
import { getProviderSpendModel, getSyncStateModel } from './store';
import { createReconcileHandlers } from './handlers';
import { buildReconciliation } from './view';
import { syncProviders } from './sync';

type Reply = { status: number; body: unknown };

let mongoServer: MongoMemoryServer;
let provider: Server;
let baseUrl: string;
let routes: Record<string, Reply> = {};
const requested: string[] = [];
const audits: any[] = [];

/** Friday 20 Nov 2026, 09:00 Dhaka. */
const NOW = new Date('2026-11-20T03:00:00Z');
const RANGE = { start: '2026-11-16', end: '2026-11-22', days: 7 };

const handlers = createReconcileHandlers({
  recordAuditEntry: async (input) => {
    audits.push(input);
  },
});

function call(
  handler: (req: ServerRequest, res: never) => Promise<unknown>,
  req: { query?: Record<string, unknown>; body?: unknown } = {},
) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const out = { status: 200 };
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(body: unknown) {
        resolve({ ...out, body });
      },
    };
    void handler(
      { query: {}, body: {}, user: { id: 'admin-1', name: 'Root' }, ...req } as never,
      res as never,
    );
  });
}

/** One ledger row; `usd` is what the ledger recorded, at provider rate. */
const row = (at: string, over: Record<string, unknown>) => ({
  createdAt: new Date(at),
  updatedAt: new Date(at),
  tokenValue: 0,
  rawAmount: 0,
  ...over,
});
const spend = (at: string, usd: number, extra: Record<string, unknown> = {}) =>
  row(at, { tokenValue: -usd * 1_000_000, tokenType: 'prompt', service: 'openrouter', ...extra });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  await getProviderSpendModel().init();
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    requested.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    const reply = routes[req.url ?? ''] ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => provider.close(resolve));
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  routes = {};
  requested.length = 0;
  audits.length = 0;
  await Promise.all(['Transaction'].map((name) => mongoose.models[name].deleteMany({})));
  await getProviderSpendModel().deleteMany({});
  await getSyncStateModel().deleteMany({});
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  OPENROUTER_MANAGEMENT_KEY: 'mgmt-test',
  OPENROUTER_API_URL: `${baseUrl}/or`,
  FIRECRAWL_API_KEY: 'fc-test',
  FIRECRAWL_API_URL: `${baseUrl}/fc`,
  ...extra,
});

const activity = (items: Array<{ model: string; usage: number; requests?: number }>): Reply => ({
  status: 200,
  body: { data: items.map((item) => ({ date: 'x', requests: 1, ...item })) },
});

describe('syncProviders', () => {
  it('stores OpenRouter spend per UTC day for the last complete days, summed over models', async () => {
    routes['/or/activity?date=2026-11-19'] = activity([
      { model: 'a/m1', usage: 1.5, requests: 3 },
      { model: 'a/m2', usage: 0.5, requests: 2 },
      { model: 'a/m1', usage: 1, requests: 1 },
    ]);
    routes['/or/activity?date=2026-11-18'] = activity([{ model: 'a/m1', usage: 2 }]);

    const [result] = await syncProviders({ days: 2 }, env(), NOW);

    expect(result).toMatchObject({ service: 'openrouter', status: 'ok', stored: 2 });
    expect(requested.every((line) => line.endsWith('Bearer mgmt-test'))).toBe(true);
    const saved = await getProviderSpendModel().findOne({ period: '2026-11-19' }).lean();
    expect(saved).toMatchObject({ amount: 3, requests: 6, source: 'openrouter_activity' });
    expect(saved?.byModel?.[0]).toMatchObject({ model: 'a/m1', usd: 2.5 });
  });

  it('is idempotent: reading a day again replaces it', async () => {
    routes['/or/activity?date=2026-11-19'] = activity([{ model: 'm', usage: 1 }]);
    await syncProviders({ days: 1 }, env(), NOW);
    routes['/or/activity?date=2026-11-19'] = activity([{ model: 'm', usage: 4 }]);
    await syncProviders({ days: 1 }, env(), NOW);
    const all = await getProviderSpendModel().find({ service: 'openrouter' }).lean();
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(4);
  });

  it('says so when the key is not a management key, and stores nothing', async () => {
    routes['/or/activity?date=2026-11-19'] = {
      status: 403,
      body: { error: { message: 'Only management keys can fetch activity for an account' } },
    };
    const [result] = await syncProviders({ days: 1 }, env(), NOW);
    expect(result).toMatchObject({ status: 'unreadable', stored: 0 });
    expect(await getProviderSpendModel().countDocuments({ service: 'openrouter' })).toBe(0);
    expect(await getSyncStateModel().findOne({ service: 'openrouter' })).toMatchObject({
      status: 'unreadable',
      httpStatus: 403,
    });
  });

  it('does not call OpenRouter without a management key', async () => {
    const [result] = await syncProviders(
      {},
      env({ OPENROUTER_MANAGEMENT_KEY: '${OPENROUTER_MANAGEMENT_KEY}' }),
      NOW,
    );
    expect(result.status).toBe('not_configured');
    expect(requested.filter((line) => line.includes('/or/'))).toEqual([]);
  });

  it('turns two Firecrawl readings into a day of credits', async () => {
    const reading = (remaining: number) => ({
      status: 200,
      body: {
        success: true,
        data: {
          remainingCredits: remaining,
          planCredits: 1000,
          billingPeriodStart: '2026-11-07T08:32:49.554Z',
          billingPeriodEnd: '2026-12-07T08:32:49.554Z',
        },
      },
    });
    routes['/fc/v2/team/credit-usage'] = reading(900);
    await syncProviders(
      { firecrawlAsOfDay: '2026-11-18' },
      env({ OPENROUTER_MANAGEMENT_KEY: '' }),
      NOW,
    );
    routes['/fc/v2/team/credit-usage'] = reading(870);
    const results = await syncProviders({ firecrawlAsOfDay: '2026-11-19' }, env(), NOW);

    expect(results.find((item) => item.service === 'firecrawl')).toMatchObject({
      status: 'ok',
      stored: 1,
    });
    const days = await getProviderSpendModel()
      .find({ service: 'firecrawl' })
      .sort({ period: 1 })
      .lean();
    expect(days.map((item) => [item.period, item.cumulative, item.amount])).toEqual([
      ['2026-11-18', 100, null],
      ['2026-11-19', 130, 30],
    ]);
  });

  it('only takes the Firecrawl reading in the first hours after midnight', async () => {
    routes['/fc/v2/team/credit-usage'] = {
      status: 200,
      body: { data: { remainingCredits: 5, planCredits: 10 } },
    };
    const midday = await syncProviders({}, env(), NOW);
    expect(midday.find((item) => item.service === 'firecrawl')?.status).toBe('skipped');
    const justAfterMidnight = new Date('2026-11-19T18:10:00Z');
    const night = await syncProviders({}, env(), justAfterMidnight);
    expect(night.find((item) => item.service === 'firecrawl')?.status).toBe('ok');
    expect(await getProviderSpendModel().findOne({ service: 'firecrawl' })).toMatchObject({
      period: '2026-11-19',
    });
  });
});

describe('buildReconciliation', () => {
  const seedWeek = async () => {
    // Ledger at provider rate, by UTC day. 16-20 Nov, plus an unfinished day (today, 20 Nov).
    await mongoose.models.Transaction.collection.insertMany([
      spend('2026-11-16T10:00:00Z', 10),
      spend('2026-11-17T10:00:00Z', 10),
      spend('2026-11-17T11:00:00Z', 1, { service: 'stt' }),
      spend('2026-11-18T10:00:00Z', 10),
      spend('2026-11-19T10:00:00Z', 10),
      spend('2026-11-20T01:00:00Z', 3),
    ]);
  };
  const provide = (day: string, amount: number | null) =>
    getProviderSpendModel().create({
      service: 'openrouter',
      period: day,
      kind: 'day',
      amount,
      source: 'openrouter_activity',
      fetchedAt: NOW,
    });

  it('is within 3% when provider days match the ledger, voice counted on the OpenRouter bill', async () => {
    await seedWeek();
    await Promise.all([
      provide('2026-11-16', 10.1),
      provide('2026-11-17', 10.9),
      provide('2026-11-18', 9.9),
      provide('2026-11-19', 10),
    ]);
    const view = await buildReconciliation(RANGE, NOW, env());
    const openrouter = view.services.find((item) => item.service === 'openrouter')!;

    expect(openrouter.weeks).toHaveLength(1);
    expect(openrouter.weeks[0]).toMatchObject({
      period: '2026-11-16',
      ledger: 41,
      provider: 40.9,
      status: 'ok',
      daysCovered: 4,
    });
    expect(openrouter.total.status).toBe('ok');
    expect(view.thresholdPct).toBe(3);
  });

  it('leaves out today, which has no complete provider day yet', async () => {
    await seedWeek();
    const view = await buildReconciliation(RANGE, NOW, env());
    const openrouter = view.services.find((item) => item.service === 'openrouter')!;
    expect(openrouter.days.map((day) => day.day)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
    ]);
  });

  it('flags a week more than 3% off and counts the flagged days', async () => {
    await seedWeek();
    await Promise.all([
      provide('2026-11-16', 10),
      provide('2026-11-17', 11),
      provide('2026-11-18', 12.5),
      provide('2026-11-19', 10),
    ]);
    const openrouter = (await buildReconciliation(RANGE, NOW, env())).services[0];
    expect(openrouter.total).toMatchObject({ ledger: 41, provider: 43.5, status: 'flagged' });
    expect(openrouter.total.gapPct).toBeCloseTo(-0.0575, 3);
    expect(openrouter.days.find((day) => day.day === '2026-11-18')?.status).toBe('flagged');
    expect(openrouter.flagged).toBe(1);
  });

  it('shows days without provider data as missing and judges the rest', async () => {
    await seedWeek();
    await Promise.all([provide('2026-11-16', 10), provide('2026-11-19', 10)]);
    const openrouter = (await buildReconciliation(RANGE, NOW, env())).services[0];
    expect(openrouter.days.map((day) => day.status)).toEqual([
      'ok',
      'missing_provider',
      'missing_provider',
      'ok',
    ]);
    expect(openrouter.weeks[0]).toMatchObject({
      daysCovered: 2,
      ledger: 20,
      provider: 20,
      ledgerAll: 41,
    });
  });

  it('reports provider spend with nothing in the ledger', async () => {
    await provide('2026-11-18', 5);
    const openrouter = (await buildReconciliation(RANGE, NOW, env())).services[0];
    expect(openrouter.days.find((day) => day.day === '2026-11-18')).toMatchObject({
      status: 'missing_ledger',
      gap: -5,
    });
  });

  it('puts a source status next to each provider', async () => {
    await getSyncStateModel().create({
      service: 'openrouter',
      lastRunAt: NOW,
      status: 'unreadable',
      httpStatus: 403,
    });
    const view = await buildReconciliation(RANGE, NOW, env({ FIRECRAWL_API_KEY: '' }));
    expect(view.services[0].source).toMatchObject({ status: 'unreadable' });
    expect(view.services[1].source).toEqual({ status: 'not_configured' });
  });

  it('compares Firecrawl credits per Dhaka day', async () => {
    await mongoose.models.Transaction.collection.insertMany([
      row('2026-11-18T05:00:00Z', { service: 'firecrawl', rawAmount: -20, tokenValue: -20 * 1000 }),
      row('2026-11-18T06:00:00Z', { service: 'firecrawl', rawAmount: -10, tokenValue: -10 * 1000 }),
      // 19:00 UTC on the 18th is already the 19th in Dhaka.
      row('2026-11-18T19:00:00Z', { service: 'firecrawl', rawAmount: -5, tokenValue: -5 * 1000 }),
    ]);
    await getProviderSpendModel().create([
      {
        service: 'firecrawl',
        period: '2026-11-18',
        kind: 'day',
        amount: 30,
        source: 'firecrawl_credit_usage',
        fetchedAt: NOW,
      },
      {
        service: 'firecrawl',
        period: '2026-11-19',
        kind: 'day',
        amount: 9,
        source: 'firecrawl_credit_usage',
        fetchedAt: NOW,
      },
    ]);
    const firecrawl = (await buildReconciliation(RANGE, NOW, env())).services[1];
    expect(firecrawl.unit).toBe('credits');
    expect(firecrawl.days.filter((day) => day.provider !== null)).toMatchObject([
      { day: '2026-11-18', ledger: 30, provider: 30, status: 'ok' },
      { day: '2026-11-19', ledger: 5, provider: 9, status: 'flagged' },
    ]);
    expect(firecrawl.usdPerUnit).toBeCloseTo(0.001, 6);
  });

  it('compares Unstructured per month with the invoice entry', async () => {
    await mongoose.models.Transaction.collection.insertMany([
      row('2026-11-05T05:00:00Z', { usageKind: 'ocr', tokenValue: -6_000_000, rawAmount: -30 }),
      row('2026-11-10T05:00:00Z', {
        service: 'unstructured',
        tokenValue: -4_000_000,
        rawAmount: -20,
      }),
    ]);
    const before = await buildReconciliation(RANGE, NOW, env());
    expect(before.unstructured).toMatchObject([
      { period: '2026-11', ledger: 10, status: 'missing_provider' },
    ]);

    await getProviderSpendModel().create({
      service: 'unstructured',
      period: '2026-11',
      kind: 'month',
      amount: 10.2,
      source: 'manual',
      fetchedAt: NOW,
    });
    const open = await buildReconciliation(RANGE, NOW, env());
    expect(open.unstructured[0]).toMatchObject({ provider: 10.2, status: 'empty' });

    const closed = await buildReconciliation(RANGE, new Date('2026-12-02T03:00:00Z'), env());
    expect(closed.unstructured[0]).toMatchObject({ provider: 10.2, status: 'ok' });
  });
});

describe('handlers', () => {
  it('serves the view for a range and rejects a bad one', async () => {
    const ok = await call(handlers.view, { query: { start: '2026-11-16', end: '2026-11-22' } });
    expect(ok.status).toBe(200);
    expect(ok.body.services.map((item: any) => item.service)).toEqual(['openrouter', 'firecrawl']);
    const bad = await call(handlers.view, { query: { start: '2026-11-22', end: '2026-11-16' } });
    expect(bad.status).toBe(400);
  });

  it('saves the Unstructured figure for a month and audits it', async () => {
    const first = await call(handlers.enterUnstructured, {
      body: { month: '2026-10', amountUsd: 41.5, pages: 1200, note: 'invoice 118' },
    });
    expect(first.status).toBe(200);
    expect(
      await getProviderSpendModel().findOne({ service: 'unstructured', period: '2026-10' }),
    ).toMatchObject({
      amount: 41.5,
      pages: 1200,
      source: 'manual',
      enteredBy: 'admin-1',
    });

    await call(handlers.enterUnstructured, { body: { month: '2026-10', amountUsd: 40 } });
    expect(await getProviderSpendModel().countDocuments({ service: 'unstructured' })).toBe(1);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: 'platform.provider_spend_entered',
      actor: { id: 'admin-1' },
      metadata: { month: '2026-10', amountUsd: 40, previous_amountUsd: 41.5 },
    });
  });

  it('rejects bad entries without writing', async () => {
    const bodies = [
      { month: '2026-13', amountUsd: 1 },
      { month: '2026-10', amountUsd: -1 },
      { month: '2026-10' },
      { month: '2099-01', amountUsd: 1 },
    ];
    for (const body of bodies) {
      expect((await call(handlers.enterUnstructured, { body })).status).toBe(400);
    }
    expect(await getProviderSpendModel().countDocuments()).toBe(0);
    expect(audits).toEqual([]);
  });

  it('refreshes provider figures on request and reports each provider', async () => {
    const result = await call(handlers.refresh, { body: { days: 99 } });
    expect(result.status).toBe(400);
    const ok = await call(handlers.refresh, { body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.results.map((item: any) => item.service)).toEqual(['openrouter', 'firecrawl']);
  });
});
