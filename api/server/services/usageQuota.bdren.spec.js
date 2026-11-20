const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

/** 1 credit per input token and 1 per output token keeps the arithmetic readable. */
const RATES = { model: 'test-model', endpoint: 'OpenRouter', rates: { input: 1, output: 1 } };
const UPGRADE_URL = 'https://bdren.test/profile/billing';

function allowance({
  month = 1000,
  week = 400,
  start = '2026-11-15T04:00:00Z',
  ceiling = null,
} = {}) {
  const startMs = new Date(start).getTime();
  const window = (days) => ({
    start: new Date(startMs),
    end: new Date(startMs + days * 86_400_000),
  });
  return {
    origin: 'fresh',
    planSource: ceiling ? 'institution' : 'personal',
    packageSlug: 'pro',
    packageName: 'Pro',
    packageVersion: 1,
    institutionId: ceiling ? 'org-1' : null,
    institutionName: ceiling ? 'Test Uni' : null,
    upgradeUrl: UPGRADE_URL,
    renews: 'monthly',
    subscriptionEndsAt: new Date(startMs + 30 * 86_400_000),
    etag: 'e',
    member: {
      month: { limit: month, window: window(30) },
      week: { limit: week, window: window(7) },
    },
    institution: ceiling
      ? {
          month: { limit: ceiling, window: window(30) },
          week: { limit: ceiling, window: window(7) },
        }
      : null,
  };
}

describe('usageQuota with a bdren.ai allowance (replica set)', () => {
  let replSet;
  let models;
  let quota;
  const tenantId = 'bdren-int';
  const userId = new mongoose.Types.ObjectId();
  const otherUserId = new mongoose.Types.ObjectId();
  let sequence = 0;

  const reserve = (overrides = {}) =>
    quota.reserveUsage({
      tenantId,
      userId,
      provider: 'openrouter',
      endpoint: 'agents',
      model: 'agent_office_assistant',
      reservationKey: `call-${(sequence += 1)}`,
      pricingContext: RATES,
      estimatedInputTokens: 100,
      requestedOutputTokens: 200,
      ...overrides,
    });

  const credits = async (scopeType, scopeKey, periodStart) =>
    (await models.UsageBucket.findOne({ tenantId, scopeType, scopeKey, periodStart }).lean())
      ?.usedTokens ?? 0;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    await Promise.all(
      ['Institution', 'UsagePolicy', 'UsageBucket', 'UsageReservation', 'UsageWarning'].map((n) =>
        models[n].syncIndexes(),
      ),
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all(
      ['Institution', 'UsagePolicy', 'UsageBucket', 'UsageReservation', 'UsageWarning'].map((n) =>
        models[n].deleteMany({}),
      ),
    );
    await models.Institution.create({
      tenantId,
      name: 'Bdren Integration',
      timezone: 'Asia/Dhaka',
      usagePolicyVersion: 1,
    });
    await models.UsagePolicy.create({
      tenantId,
      version: 1,
      mode: 'enforce',
      timezone: 'Asia/Dhaka',
      limits: {},
      inputSafetyFactor: 1,
      inputSafetyTokens: 0,
      effectiveAt: new Date(),
      reason: 'bdren integration test',
    });
  });

  it('meters a user with no Synapse package once an allowance is given, in the subscription windows', async () => {
    const plan = allowance();
    const result = await reserve({ allowance: plan });

    expect(result.reservation.status).toBe('reserved');
    const scopes = result.reservation.scopes;
    const member = scopes.filter((s) => s.scopeType === 'member_credits');
    const month = member.find((s) => s.window === 'month');
    const week = member.find((s) => s.window === 'week');
    expect(month.limit).toBe(1000);
    expect(week.limit).toBe(400);
    expect(new Date(month.periodStart).toISOString()).toBe('2026-11-15T04:00:00.000Z');
    expect(new Date(month.periodEnd).toISOString()).toBe('2026-12-15T04:00:00.000Z');
    expect(new Date(week.periodEnd).toISOString()).toBe('2026-11-22T04:00:00.000Z');
  });

  it('keeps the first week and the month in separate buckets, charging each once', async () => {
    const plan = allowance();
    const { reservation } = await reserve({ allowance: plan });
    await quota.settleUsage({
      tenantId,
      reservationKey: reservation.reservationKey,
      usage: null,
      credits: 120,
    });

    const [monthRange, weekRange] = ['month', 'week'].map(
      (window) =>
        reservation.scopes.find(
          (scope) => scope.scopeType === 'member_credits' && scope.window === window,
        ).periodStart,
    );
    expect(new Date(monthRange).getTime()).not.toBe(new Date(weekRange).getTime());
    expect(await credits('member_credits', String(userId), monthRange)).toBe(120);
    expect(await credits('member_credits', String(userId), weekRange)).toBe(120);
  });

  it('refuses with the plan, the upgrade link and the reset of the binding window', async () => {
    const plan = allowance({ month: 1000, week: 150 });
    await reserve({ allowance: plan, estimatedInputTokens: 100, requestedOutputTokens: 40 });

    const error = await reserve({
      allowance: plan,
      estimatedInputTokens: 100,
      requestedOutputTokens: 40,
    }).catch((e) => e);
    const again = await reserve({
      allowance: plan,
      estimatedInputTokens: 60,
      requestedOutputTokens: 40,
    }).catch((e) => e);

    const denied = [error, again].find((e) => e?.name === 'QuotaError');
    expect(denied).toBeDefined();
    expect(denied.details.limitCode).toBe('WEEKLY_CAP');
    expect(denied.details.upgradeUrl).toBe(UPGRADE_URL);
    expect(denied.details.packageName).toBe('Pro');
    expect(denied.details.planSource).toBe('personal');
    expect(denied.details.resetAt).toBe('2026-11-22T04:00:00.000Z');
    expect(JSON.parse(denied.message).upgradeUrl).toBe(UPGRADE_URL);
  });

  it("applies each user's own allowance: one user's limit never limits another", async () => {
    const small = allowance({ month: 50, week: 50 });
    const large = allowance({ month: 100000, week: 100000 });

    const denied = await reserve({ allowance: small, estimatedInputTokens: 100 }).catch((e) => e);
    const allowed = await reserve({
      allowance: large,
      userId: otherUserId,
      estimatedInputTokens: 100,
    });

    expect(denied.name).toBe('QuotaError');
    expect(allowed.reservation.status).toBe('reserved');
  });

  it('applies the institution ceiling for a seat only, and never as a pool for personal plans', async () => {
    const seat = allowance({ month: 1000, week: 1000, ceiling: 300 });
    const first = await reserve({
      allowance: seat,
      estimatedInputTokens: 100,
      requestedOutputTokens: 100,
    });
    await quota.settleUsage({
      tenantId,
      reservationKey: first.reservation.reservationKey,
      usage: null,
      credits: 200,
    });

    const blocked = await reserve({
      allowance: seat,
      userId: otherUserId,
      estimatedInputTokens: 150,
      requestedOutputTokens: 10,
    }).catch((e) => e);
    expect(blocked.name).toBe('QuotaError');
    expect(blocked.details.limitCode).toBe('INSTITUTION_CAP');

    const personal = allowance({ month: 1000, week: 1000 });
    const free = await reserve({
      allowance: personal,
      userId: otherUserId,
      estimatedInputTokens: 150,
    });
    expect(free.reservation.status).toBe('reserved');
  });

  it('opens a fresh bucket when the window moves, so a new subscription starts counting from zero', async () => {
    const before = allowance({ start: '2026-11-01T04:00:00Z' });
    const first = await reserve({ allowance: before });
    await quota.settleUsage({
      tenantId,
      reservationKey: first.reservation.reservationKey,
      usage: null,
      credits: 300,
    });

    const after = allowance({ start: '2026-11-20T04:00:00Z' });
    const second = await reserve({ allowance: after });
    const month = second.reservation.scopes.find(
      (s) => s.scopeType === 'member_credits' && s.window === 'month',
    );
    expect(await credits('member_credits', String(userId), month.periodStart)).toBe(0);
  });

  it('GET quota shows the plan, the windows and the used amount', async () => {
    const plan = allowance();
    const { reservation } = await reserve({ allowance: plan });
    await quota.settleUsage({
      tenantId,
      reservationKey: reservation.reservationKey,
      usage: null,
      credits: 90,
    });

    const view = await quota.getMemberQuota({ tenantId, userId, allowance: plan });

    expect(view.package.name).toBe('Pro');
    expect(view.plan.upgradeUrl).toBe(UPGRADE_URL);
    const monthMeter = view.meters.find((m) => m.meter === 'credits' && m.window === 'month');
    expect(monthMeter.used).toBe(90);
    expect(monthMeter.limit).toBe(1000);
    expect(monthMeter.resetsAt).toBe('2026-12-15T04:00:00.000Z');
  });

  describe('services outside the model (Firecrawl, OCR)', () => {
    const afford = (credits, plan = allowance({ month: 100, week: 100 })) =>
      quota.canAffordCredits({ tenantId, userId, allowance: plan, credits });

    it('refuses a service the remaining allowance cannot cover, and allows one it can', async () => {
      expect(await afford(60)).toBe(true);
      expect(await afford(101)).toBe(false);
    });

    it('draws a charge from the allowance exactly once per key', async () => {
      const plan = allowance({ month: 100, week: 100 });
      const args = {
        tenantId,
        userId,
        allowance: plan,
        reservationKey: 'firecrawl:u:c:m:call-1',
        credits: 40,
        metadata: { service: 'web_search' },
      };

      await quota.recordAuxiliaryCredits(args);
      await quota.recordAuxiliaryCredits(args);

      const month = plan.member.month.window.start;
      expect(await credits('member_credits', String(userId), month)).toBe(40);
      expect(await afford(61, plan)).toBe(false);
      expect(await afford(60, plan)).toBe(true);
    });

    it('is not refused by the estimate an open chat reservation holds', async () => {
      const plan = allowance({ month: 1000, week: 1000 });
      await reserve({ allowance: plan, estimatedInputTokens: 100, requestedOutputTokens: 800 });

      expect(await afford(50, plan)).toBe(true);
    });

    it('does not refuse while the policy only observes', async () => {
      await models.UsagePolicy.deleteMany({ tenantId });
      await models.UsagePolicy.create({
        tenantId,
        version: 1,
        mode: 'shadow',
        timezone: 'Asia/Dhaka',
        limits: {},
        effectiveAt: new Date(),
        reason: 'shadow',
      });
      expect(await afford(10_000)).toBe(true);
    });
  });
});
