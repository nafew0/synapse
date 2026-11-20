/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON bodies in endpoint assertions */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, INDIVIDUAL_USAGE_ACCOUNT } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { createSpendHandlers, parseRange, previousRange, toCsv } from './spend';

let mongoServer: MongoMemoryServer;
const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const carol = new mongoose.Types.ObjectId();
const dave = new mongoose.Types.ObjectId();

let pricing: { bdtPerUsd: number; providerFeePercent: number; defaultWeeklyPercent: number } | null;
const audits: unknown[] = [];
const handlers = createSpendHandlers({
  getUsagePricing: async () => pricing as never,
  saveUsagePricing: async (fields) => {
    pricing = fields;
    return { ...fields, updatedAt: new Date() } as never;
  },
  recordAuditEntry: async (input) => {
    audits.push(input);
  },
});

const bucket = (over: Record<string, unknown>) => ({
  key: `${Math.random()}`,
  day: '2026-11-10',
  service: 'openrouter',
  billable: true,
  requests: 1,
  units: 100,
  inputTokens: 60,
  outputTokens: 40,
  pages: 0,
  costUsd: 1,
  rows: 1,
  ...over,
});

function call(
  handler: (req: ServerRequest, res: never) => Promise<unknown>,
  query: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
    const out = { status: 200, headers: {} as Record<string, string> };
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      set(headers: Record<string, string>) {
        Object.assign(out.headers, headers);
        return res;
      },
      json(body: unknown) {
        resolve({ ...out, body });
      },
      send(body: unknown) {
        resolve({ ...out, body });
      },
    };
    void handler({ query, user: { id: String(alice) }, ...extra } as never, res as never);
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  pricing = { bdtPerUsd: 120, providerFeePercent: 10, defaultWeeklyPercent: 35 };
  audits.length = 0;
  await Promise.all(
    ['UsageDaily', 'Institution', 'CostSettings', 'User', 'Transaction'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
  await mongoose.models.Institution.create([
    { tenantId: 'uni-a', name: 'University A' },
    { tenantId: 'uni-b', name: 'University B' },
  ]);
  await mongoose.models.User.create([
    { _id: alice, name: 'Alice', email: 'alice@a.test', username: 'alice' },
    { _id: bob, name: 'Bob', email: 'bob@a.test', username: 'bob' },
  ]);
  await mongoose.models.UsageDaily.create([
    bucket({ tenantId: 'uni-a', user: alice, costUsd: 10, modelKey: 'claude-haiku-5.5' }),
    bucket({
      tenantId: 'uni-a',
      user: alice,
      service: 'unstructured',
      costUsd: 2,
      pages: 8,
      units: 8,
      modelKey: 'unstructured/ocr',
    }),
    bucket({
      tenantId: 'uni-a',
      user: bob,
      service: 'firecrawl',
      costUsd: 1,
      modelKey: 'firecrawl/web_search',
    }),
    bucket({ tenantId: 'uni-a', user: bob, billable: false, service: 'embeddings', costUsd: 0.5 }),
    bucket({
      tenantId: 'uni-b',
      user: carol,
      costUsd: 4,
      day: '2026-11-11',
      modelKey: 'claude-haiku-5.5',
    }),
    bucket({ user: dave, costUsd: 3, modelKey: 'gemini' }),
    bucket({ tenantId: INDIVIDUAL_USAGE_ACCOUNT, user: dave, costUsd: 1, modelKey: 'gemini' }),
    bucket({ costUsd: 0.25, service: 'firecrawl' }),
    bucket({ tenantId: 'uni-a', user: alice, costUsd: 5, day: '2026-10-30' }),
  ]);
});

const RANGE = { start: '2026-11-01', end: '2026-11-30' };

describe('range', () => {
  it('parses, defaults and previous window', () => {
    expect(parseRange(RANGE)).toEqual({ ...RANGE, days: 30 });
    expect(parseRange({}, new Date('2026-11-20T10:00:00Z')).end).toBe('2026-11-20');
    expect(previousRange(parseRange(RANGE))).toEqual({
      start: '2026-10-02',
      end: '2026-10-31',
      days: 30,
    });
    expect(() => parseRange({ start: '2026-12-01', end: '2026-11-01' })).toThrow(RangeError);
    expect(() => parseRange({ start: '2024-01-01', end: '2026-11-01' })).toThrow(RangeError);
  });

  it('rejects a bad range with 400', async () => {
    const res = await call(handlers.summary, { start: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('summary', () => {
  it('applies the fee to openrouter only, converts to BDT and compares periods', async () => {
    const { body } = await call(handlers.summary, RANGE);
    // openrouter 10+4+3+1 = 18 (+10% = 19.8); others 2+1+0.5+0.25 = 3.75
    expect(body.current.cost.ledgerUsd).toBeCloseTo(21.75);
    expect(body.current.cost.feeUsd).toBeCloseTo(1.8);
    expect(body.current.cost.costUsd).toBeCloseTo(23.55);
    expect(body.current.cost.costBdt).toBeCloseTo(23.55 * 120);
    expect(body.current.cost.platformUsd).toBeCloseTo(0.5);
    expect(body.current.byService.openrouter).toBeCloseTo(19.8);
    expect(body.current.activeUsers).toBe(4);
    expect(body.current.costPerActiveUser).toBeCloseTo(23.55 / 4);
    expect(body.previous.cost.costUsd).toBeCloseTo(5.5);
    expect(body.change.costUsd).toBeCloseTo((23.55 - 5.5) / 5.5, 3);
  });

  it('adds prorated fixed costs to the grand total', async () => {
    await call(
      handlers.updateSettings,
      {},
      {
        body: {
          fixedCosts: [
            { label: 'Server', amount: 3000, currency: 'BDT' },
            { label: 'Plan', amount: 60, currency: 'USD' },
          ],
        },
      },
    );
    const { body } = await call(handlers.summary, RANGE);
    // a full month: 3000/120 + 60 = 85
    expect(body.fixed.periodUsd).toBeCloseTo(85);
    expect(body.grandTotal.usd).toBeCloseTo(23.55 + 85);
    expect(body.grandTotal.bdt).toBeCloseTo((23.55 + 85) * 120, 2);
    const half = await call(handlers.summary, { start: '2026-11-01', end: '2026-11-15' });
    expect(half.body.fixed.periodUsd).toBeCloseTo(42.5);
  });
});

describe('institutions (all-institutions view)', () => {
  it('lists institutions, Individuals and Platform with services included', async () => {
    const { body } = await call(handlers.institutions, RANGE);
    const byId = Object.fromEntries(body.institutions.map((i: any) => [i.tenantId, i]));
    expect(Object.keys(byId).sort()).toEqual(['__individuals__', '__platform__', 'uni-a', 'uni-b']);
    expect(body.institutions[0].tenantId).toBe('uni-a');
    expect(byId['uni-a'].name).toBe('University A');
    expect(byId['uni-a'].cost.costUsd).toBeCloseTo(10 * 1.1 + 2 + 1 + 0.5);
    expect(byId['uni-a'].byService.unstructured).toBeCloseTo(2);
    expect(byId['uni-a'].activeMembers).toBe(2);
    expect(byId['uni-a'].costPerActiveMember).toBeCloseTo(byId['uni-a'].cost.costUsd / 2);
    expect(byId['uni-a'].topModel).toBe('claude-haiku-5.5');
    expect(byId['uni-a'].previousCostUsd).toBeCloseTo(5.5);
    expect(byId['uni-a'].changeVsPrevious).toBeCloseTo((14.5 - 5.5) / 5.5, 3);
    // tenant-less rows with a user are Individuals, together with the explicit account
    expect(byId.__individuals__.cost.costUsd).toBeCloseTo(4.4);
    expect(byId.__platform__.cost.ledgerUsd).toBeCloseTo(0.25);
    expect(byId.__platform__.name).toBe('Platform / unattributed');
    const shares = body.institutions.reduce((s: number, i: any) => s + i.shareOfTotal, 0);
    expect(shares).toBeCloseTo(1, 2);
  });

  it('sorts by name', async () => {
    const { body } = await call(handlers.institutions, { ...RANGE, sort: 'name' });
    expect(body.institutions[0].name).toBe('Individuals');
  });
});

describe('services, timeseries, members, institution detail', () => {
  it('breaks cost down by service with top institutions', async () => {
    const { body } = await call(handlers.services, RANGE);
    const fire = body.services.find((s: any) => s.service === 'firecrawl');
    expect(fire.costUsd).toBeCloseTo(1.25);
    expect(fire.topInstitutions[0].tenantId).toBe('uni-a');
    const ocr = body.services.find((s: any) => s.service === 'unstructured');
    expect(ocr.pages).toBe(8);
  });

  it('fills every day of the range, grouped by service or institution', async () => {
    const { body } = await call(handlers.timeseries, {
      start: '2026-11-09',
      end: '2026-11-12',
      groupBy: 'service',
    });
    expect(body.days).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    const router = body.series.find((s: any) => s.key === 'openrouter');
    expect(router.values).toEqual([0, 14 * 1.1, 4 * 1.1, 0].map((v) => Math.round(v * 1e6) / 1e6));
    const inst = await call(handlers.timeseries, {
      start: '2026-11-09',
      end: '2026-11-12',
      groupBy: 'institution',
    });
    expect(inst.body.series.find((s: any) => s.key === 'uni-b').label).toBe('University B');
    expect((await call(handlers.timeseries, { groupBy: 'x' })).status).toBe(400);
  });

  it('gives per member cost by service, including service rows', async () => {
    const { body } = await call(handlers.members, { ...RANGE, tenantId: 'uni-a' });
    expect(body.members.map((m: any) => m.name)).toEqual(['Alice', 'Bob']);
    expect(body.members[0].byService).toEqual({ openrouter: 11, unstructured: 2 });
    expect(body.members[0].costUsd).toBeCloseTo(13);
  });

  it('gives one institution by service, model, member and day', async () => {
    const { body } = await call(handlers.institution, RANGE, { params: { tenantId: 'uni-a' } });
    expect(body.name).toBe('University A');
    expect(body.activeMembers).toBe(2);
    expect(body.byModel[0].model).toBe('claude-haiku-5.5');
    expect(body.byModel.some((m: any) => m.service === 'unstructured')).toBe(true);
    expect(body.byMember).toHaveLength(2);
    expect(body.byDay).toHaveLength(1);
    expect(body.cost.costUsd).toBeCloseTo(14.5);
    const missing = await call(handlers.institution, RANGE, { params: { tenantId: 'nope' } });
    expect(missing.status).toBe(404);
  });
});

describe('requests drill-down', () => {
  it('pages through Transaction rows with the ledger cost', async () => {
    const base = { user: alice, tenantId: 'uni-a', tokenType: 'credits', rawAmount: 1 };
    await mongoose.models.Transaction.create([
      {
        ...base,
        tokenValue: -2_000_000,
        service: 'firecrawl',
        createdAt: new Date('2026-11-10T05:00:00Z'),
      },
      {
        ...base,
        tokenValue: -1_000_000,
        service: 'openrouter',
        createdAt: new Date('2026-11-10T06:00:00Z'),
      },
      {
        ...base,
        tokenValue: -500_000,
        createdAt: new Date('2026-11-10T07:00:00Z'),
        usageKind: 'ocr',
      },
    ]);
    const page1 = await call(handlers.requests, { ...RANGE, tenantId: 'uni-a', limit: 2 });
    expect(page1.body.requests).toHaveLength(2);
    expect(page1.body.next).toBeTruthy();
    const page2 = await call(handlers.requests, {
      ...RANGE,
      tenantId: 'uni-a',
      limit: 2,
      before: page1.body.next,
    });
    expect(page2.body.requests).toHaveLength(1);
    expect(page2.body.next).toBeNull();
    const ocr = await call(handlers.requests, { ...RANGE, service: 'unstructured' });
    expect(ocr.body.requests).toHaveLength(1);
    expect(ocr.body.requests[0].ledgerUsd).toBeCloseTo(0.5);
    expect((await call(handlers.requests, { ...RANGE, user: 'x' })).status).toBe(400);
  });
});

describe('export', () => {
  it('returns the institutions, members and daily sheets as CSV', async () => {
    const inst = await call(handlers.exportCsv, RANGE);
    expect(inst.headers['Content-Type']).toContain('text/csv');
    expect(inst.headers['Content-Disposition']).toContain(
      'costs-institutions-2026-11-01_2026-11-30.csv',
    );
    const lines = String(inst.body).trim().split('\r\n');
    expect(lines[0]).toContain('tenantId,name,costUsd,costBdt');
    expect(lines[0]).toContain('unstructuredUsd');
    expect(lines).toHaveLength(5);
    expect(lines[1].startsWith('uni-a,University A,')).toBe(true);
    const members = await call(handlers.exportCsv, { ...RANGE, sheet: 'members' });
    expect(String(members.body)).toContain('Alice,alice@a.test,uni-a');
    const daily = await call(handlers.exportCsv, { ...RANGE, sheet: 'daily' });
    expect(String(daily.body).trim().split('\r\n')).toHaveLength(3);
    expect((await call(handlers.exportCsv, { ...RANGE, sheet: 'x' })).status).toBe(400);
  });

  it('escapes cells and neutralises formulas', () => {
    expect(toCsv(['a'], [['=SUM(A1)'], ['x,"y"'], [-3]])).toBe(
      'a\r\n\'=SUM(A1)\r\n"x,""y"""\r\n-3\r\n',
    );
  });
});

describe('settings', () => {
  it('reads defaults, saves the rate, fee and fixed costs, and audits', async () => {
    pricing = null;
    const read = await call(handlers.getSettings);
    expect(read.body.settings).toMatchObject({
      bdtPerUsd: 123,
      providerFeePercent: 0,
      configured: false,
      fixedCosts: [],
    });
    const saved = await call(
      handlers.updateSettings,
      {},
      {
        body: {
          bdtPerUsd: 125,
          providerFeePercent: 5.5,
          fixedCosts: [{ label: 'Langfuse host', amount: 20, currency: 'USD' }],
        },
      },
    );
    expect(saved.body.settings).toMatchObject({
      bdtPerUsd: 125,
      providerFeePercent: 5.5,
      configured: true,
    });
    expect(saved.body.settings.fixedCosts[0].id).toBeTruthy();
    expect((pricing as { defaultWeeklyPercent: number } | null)?.defaultWeeklyPercent).toBe(35);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { action: string }).action).toBe('platform.cost_settings_updated');
    const summary = await call(handlers.summary, RANGE);
    expect(summary.body.range.bdtPerUsd).toBe(125);
  });

  it('rejects bad input', async () => {
    expect((await call(handlers.updateSettings, {}, { body: {} })).status).toBe(400);
    expect((await call(handlers.updateSettings, {}, { body: { bdtPerUsd: 0 } })).status).toBe(400);
    expect((await call(handlers.updateSettings, {}, { body: { other: 1 } })).status).toBe(400);
  });
});

describe('review fixes', () => {
  it('platform key has no active members and a user in two tenants is two rows', async () => {
    const { body } = await call(handlers.institution, RANGE, {
      params: { tenantId: '__platform__' },
    });
    expect(body.activeMembers).toBe(0);
    const all = await call(handlers.members, RANGE);
    const daveRows = all.body.members.filter((m: any) => m.user === String(dave));
    expect(daveRows).toHaveLength(1);
    await mongoose.models.UsageDaily.create(bucket({ tenantId: 'uni-b', user: dave, costUsd: 1 }));
    const again = await call(handlers.members, RANGE);
    expect(again.body.members.filter((m: any) => m.user === String(dave))).toHaveLength(2);
  });

  it('treats a service starting with $ literally', async () => {
    const res = await call(handlers.requests, { ...RANGE, service: '$user' });
    expect(res.body.requests).toHaveLength(0);
  });
});
