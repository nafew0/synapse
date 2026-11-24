import express from 'express';
import request from 'supertest';
import type { TQuotaMeterState, TQuotaResponse } from 'librechat-data-provider';
import type { PlanUsageDeps } from './plan';
import type { ResolvedAllowance } from './types';
import { readBdrenConfig } from './config';
import { createPlanUsageHandler } from './plan';
import { fallbackAllowance } from './windows';

const config = readBdrenConfig({
  BDREN_ALLOWANCE_ENABLED: 'true',
  BDREN_API_URL: 'https://bdren.test',
  BDREN_PRODUCT_KEY: 'k',
  BDREN_ISSUER: 'https://auth.bdren.test',
});
const now = new Date('2026-11-23T06:00:00.000Z');

const credits = (window: 'week' | 'month', used: number, limit: number): TQuotaMeterState => ({
  meter: 'credits',
  window,
  used,
  limit,
  remaining: limit - used,
  unlimited: false,
  blocked: used >= limit,
  resetsAt: window === 'week' ? '2026-11-29T18:00:00.000Z' : '2026-11-30T18:00:00.000Z',
  usedBdt: used / 7400,
  limitBdt: limit / 7400,
  remainingBdt: (limit - used) / 7400,
});

const creditQuota = (name: string): TQuotaResponse => ({
  tenantId: 'acct',
  unit: 'credits',
  package: { key: 'pro', name, unlimited: false },
  meters: [
    credits('month', 1_000_000, 4_000_000),
    credits('week', 200_000, 1_000_000),
    { ...credits('month', 0, 0), meter: 'institution', used: null, limit: null },
  ],
});

const proAllowance = (overrides: Partial<ResolvedAllowance> = {}): ResolvedAllowance => ({
  ...fallbackAllowance(config, now),
  origin: 'fresh',
  planSource: 'personal',
  packageSlug: 'pro',
  packageName: 'Pro',
  upgradeUrl: 'https://bdren.ai/pricing',
  subscriptionEndsAt: new Date('2026-12-23T00:00:00.000Z'),
  ...overrides,
});

function app(deps: Partial<PlanUsageDeps>, user: object | null = { id: 'u1', usagePackage: null }) {
  const server = express();
  server.use((req, _res, next) => {
    if (user) {
      (req as express.Request & { user?: object }).user = user;
    }
    next();
  });
  server.get(
    '/api/quota/plan',
    createPlanUsageHandler({
      linked: () => true,
      resolveAccount: async () => 'acct',
      getAllowance: async () => null,
      getMemberQuota: async () => null,
      ...deps,
    }),
  );
  return server;
}

describe('GET /api/quota/plan', () => {
  it('shows a personal bdren.ai package with its weekly and monthly allowance, week first', async () => {
    const getMemberQuota = jest.fn(async () => creditQuota('Pro'));
    const res = await request(
      app({ getAllowance: async () => proAllowance(), getMemberQuota }),
    ).get('/api/quota/plan');

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.managed).toBe(true);
    expect(res.body.plan).toEqual({
      name: 'Pro',
      source: 'personal',
      institutionName: null,
      endsAt: '2026-12-23T00:00:00.000Z',
      upgradeUrl: 'https://bdren.ai/pricing',
      stale: false,
      unlimited: false,
    });
    expect(res.body.periods.map((p: TQuotaMeterState) => p.window)).toEqual(['week', 'month']);
    expect(res.body.periods[1]).toMatchObject({ used: 1_000_000, limit: 4_000_000 });
    expect(getMemberQuota).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'acct', userId: 'u1' }),
    );
  });

  it("names the institution for a covered member and shows the institution's package", async () => {
    const res = await request(
      app({
        getAllowance: async () =>
          proAllowance({
            planSource: 'institution',
            packageName: 'Campus Plus',
            institutionName: 'Dhaka University',
          }),
        getMemberQuota: async () => creditQuota('Campus Plus'),
      }),
    ).get('/api/quota/plan');

    expect(res.body.plan).toMatchObject({
      name: 'Campus Plus',
      source: 'institution',
      institutionName: 'Dhaka University',
    });
  });

  it('marks the Free fallback as stale when bdren.ai could not answer', async () => {
    const res = await request(
      app({
        getAllowance: async () => fallbackAllowance(config, now),
        getMemberQuota: async () => creditQuota('Free'),
      }),
    ).get('/api/quota/plan');

    expect(res.body.plan).toMatchObject({
      name: 'Free',
      source: 'free',
      stale: true,
      upgradeUrl: 'https://bdren.ai/pricing#subscribe',
    });
  });

  it('with the bdren.ai link off, shows the Synapse package and says it is not linked', async () => {
    const res = await request(
      app({ linked: () => false, getMemberQuota: async () => creditQuota('Synapse Basic') }),
    ).get('/api/quota/plan');

    expect(res.body).toMatchObject({ linked: false, managed: false });
    expect(res.body.plan).toMatchObject({ name: 'Synapse Basic', source: null, upgradeUrl: null });
  });

  it('returns no plan and no periods for staff without a quota account', async () => {
    const getMemberQuota = jest.fn();
    const res = await request(app({ resolveAccount: async () => null, getMemberQuota })).get(
      '/api/quota/plan',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: true, managed: false, plan: null, periods: [] });
    expect(getMemberQuota).not.toHaveBeenCalled();
  });

  it('leaves token-policy meters out, since they are not an AI allowance in credits', async () => {
    const res = await request(
      app({
        getMemberQuota: async () => ({
          tenantId: 'acct',
          unit: 'billing_tokens',
          meters: [{ ...credits('month', 1, 2), meter: 'tokens' }],
        }),
      }),
    ).get('/api/quota/plan');

    expect(res.body.periods).toEqual([]);
    expect(res.body.plan).toBeNull();
  });

  it('answers 500 when the meters cannot be read', async () => {
    const res = await request(
      app({
        getMemberQuota: async () => {
          throw new Error('mongo down');
        },
      }),
    ).get('/api/quota/plan');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load plan usage' });
  });

  it('answers 401 without a signed-in user', async () => {
    const res = await request(app({}, null)).get('/api/quota/plan');
    expect(res.status).toBe(401);
  });
});
