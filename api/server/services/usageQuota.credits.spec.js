const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

/** GPT-5.6 Luna on OpenRouter: 0.2 credits per input token, 1.2 per output token. */
const LUNA = {
  model: 'openai/gpt-5.6-luna',
  endpoint: 'OpenRouter',
  rates: { input: 0.2, output: 1.2 },
};

describe('usageQuota credit metering (replica set)', () => {
  let replSet;
  let models;
  let quota;
  let usageCatalog;
  const tenantId = 'credit-integration';
  const userId = new mongoose.Types.ObjectId();
  const otherUserId = new mongoose.Types.ObjectId();
  let sequence = 0;

  /** BDT allowance for a given number of monthly credits at the default 123 BDT/USD. */
  const bdtFor = (credits) => (credits / 1e6) * 123;

  const createPackage = (key, monthlyCredits, overrides = {}) =>
    models.UsagePackage.create({
      key,
      name: key,
      scopes: ['member', 'institution'],
      price: 0,
      monthlyCredit: bdtFor(monthlyCredits),
      ...overrides,
    });

  const reserve = (overrides = {}) =>
    quota.reserveUsage({
      tenantId,
      userId,
      provider: 'openrouter',
      endpoint: 'agents',
      model: 'agent_office_assistant',
      reservationKey: `call-${(sequence += 1)}`,
      pricingContext: LUNA,
      estimatedInputTokens: 100,
      requestedOutputTokens: 400,
      ...overrides,
    });

  const bucket = (scopeType, scopeKey, periodStart) =>
    models.UsageBucket.findOne({ tenantId, scopeType, scopeKey, periodStart }).lean();

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    usageCatalog = require('./usageCatalog');
    await Promise.all([
      models.Institution.syncIndexes(),
      models.UsagePolicy.syncIndexes(),
      models.UsageBucket.syncIndexes(),
      models.UsageReservation.syncIndexes(),
      models.UsageWarning.syncIndexes(),
      models.UsagePackage.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });

  beforeEach(async () => {
    usageCatalog.invalidate();
    await Promise.all(
      [
        'Institution',
        'UsagePolicy',
        'UsageBucket',
        'UsageReservation',
        'UsageWarning',
        'UsagePackage',
        'UsagePricing',
      ].map((name) => models[name].deleteMany({})),
    );
    await models.Institution.create({
      tenantId,
      name: 'Credit Integration',
      timezone: 'Asia/Dhaka',
      usagePolicyVersion: 1,
      usagePackage: { packageKey: 'pool', memberPackageKey: 'member' },
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
      reason: 'credit integration test',
    });
  });

  describe('reserving and settling', () => {
    beforeEach(async () => {
      await createPackage('pool', 10_000_000);
      await createPackage('member', 1_000_000);
    });

    it('reserves the estimate at the request model in all four credit buckets', async () => {
      const { reservation } = await reserve();
      const estimate = 100 * 0.2 + 400 * 1.2;
      expect(reservation).toMatchObject({ unit: 'credits', reservedTokens: estimate });
      expect(reservation.metadata).toMatchObject({
        rates: { input: 0.2, output: 1.2 },
        institutionPackageKey: 'pool',
        memberPackageKey: 'member',
      });
      expect(reservation.scopes.map((scope) => `${scope.scopeType}:${scope.window}`)).toEqual([
        'institution_credits:month',
        'institution_credits:week',
        'member_credits:month',
        'member_credits:week',
      ]);
      for (const scope of reservation.scopes) {
        const held = await bucket(scope.scopeType, scope.scopeKey, scope.periodStart);
        expect(held).toMatchObject({ usedTokens: 0, reservedTokens: estimate });
      }
    });

    it('settles at the actual credits the client priced, releasing the estimate', async () => {
      const { reservation } = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: reservation.reservationKey,
        credits: 333,
      });
      for (const scope of reservation.scopes) {
        const settled = await bucket(scope.scopeType, scope.scopeKey, scope.periodStart);
        expect(settled).toMatchObject({ usedTokens: 333, reservedTokens: 0 });
      }
    });

    it('prices tokens at the reserved rates when the client sends no credits', async () => {
      const { reservation } = await reserve();
      const settled = await quota.settleUsage({
        tenantId,
        reservationKey: reservation.reservationKey,
        usage: { inputTokens: 50, cacheReadTokens: 50, outputTokens: 100 },
      });
      expect(settled.actualTokens).toBe(100 * 0.2 + 100 * 1.2);
    });

    it('replays a reservation idempotently', async () => {
      const first = await reserve({ reservationKey: 'same' });
      const second = await reserve({ reservationKey: 'same' });
      expect(second.idempotentReplay).toBe(true);
      expect(String(second.reservation._id)).toBe(String(first.reservation._id));
      expect(await models.UsageReservation.countDocuments({ reservationKey: 'same' })).toBe(1);
    });

    it("lets a member's own package override the institution default", async () => {
      await createPackage('vip', 50_000_000, { scopes: ['member'], unlimited: true });
      const { reservation } = await reserve({ memberPackage: { packageKey: 'vip' } });
      expect(reservation.metadata.memberPackageKey).toBe('vip');
      expect(reservation.scopes.find((scope) => scope.scopeType === 'member_credits').limit).toBe(
        50_000_000,
      );
    });

    it('keeps a tenant with no packages on the token policy', async () => {
      await models.Institution.updateOne({ tenantId }, { $set: { usagePackage: null } });
      const { reservation } = await reserve();
      expect(reservation.unit).toBe('tokens');
    });
  });

  describe('weekly and monthly walls', () => {
    it('trims the output to the remaining weekly allowance, then refuses with WEEKLY_CAP', async () => {
      await createPackage('pool', 10_000_000);
      /** 1,000 credits a month, so 350 a week at the 35% default. */
      await createPackage('member', 1_000);

      const first = await reserve();
      expect(first.outputCapped).toBe(true);
      expect(first.outputTokenCap).toBe(Math.floor((350 - 20) / 1.2));
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 340,
      });

      await expect(reserve()).rejects.toMatchObject({
        statusCode: 429,
        details: expect.objectContaining({
          code: 'TOKEN_QUOTA_EXCEEDED',
          limitCode: 'WEEKLY_CAP',
          window: 'week',
          meter: 'credits',
        }),
      });
    });

    it('names the week and its Monday reset even though the month still has room', async () => {
      await createPackage('pool', 10_000_000);
      await createPackage('member', 1_000);
      const first = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 350,
      });
      const error = await reserve().catch((caught) => caught);
      const week = quota.getCalendarWeekRange(quota.QUOTA_RESET_TIMEZONE);
      expect(error.details.resetAt).toBe(week.end.toISOString());
      expect(new Date(error.details.resetAt).getUTCDay()).toBe(1);
      expect(JSON.parse(error.message)).toEqual({
        type: 'token_quota_exceeded',
        limitCode: 'WEEKLY_CAP',
        window: 'week',
        meter: 'credits',
        resetAt: week.end.toISOString(),
      });
    });

    it("refuses every member once the institution's weekly pool is spent", async () => {
      /** 3,000 credits a month for the whole institution, so 1,050 a week. */
      await createPackage('pool', 3_000);
      await createPackage('member', 10_000_000);
      const first = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 1_050,
      });
      await expect(reserve({ userId: otherUserId })).rejects.toMatchObject({
        details: expect.objectContaining({ limitCode: 'INSTITUTION_WEEKLY_CAP', window: 'week' }),
      });
    });

    it('records usage but never refuses or trims in shadow mode', async () => {
      /** `mode` is immutable on the schema, so the test writes the collection directly. */
      await models.UsagePolicy.collection.updateOne({ tenantId }, { $set: { mode: 'shadow' } });
      await createPackage('pool', 10_000_000);
      await createPackage('member', 10);
      const result = await reserve();
      expect(result.outputTokenCap).toBeNull();
      expect(result.reservation.metadata.shadowWouldDeny).toBe(true);
    });
  });

  describe('getMemberQuota', () => {
    it('reports the member in credits and taka, and only whether the institution is blocked', async () => {
      await createPackage('pool', 10_000_000);
      await createPackage('member', 1_000_000, { name: 'Standard' });
      const first = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 100_000,
      });

      const result = await quota.getMemberQuota({ tenantId, userId });
      expect(result).toMatchObject({
        unit: 'credits',
        enforced: true,
        package: { key: 'member', name: 'Standard', unlimited: false },
      });
      const month = result.meters.find((m) => m.meter === 'credits' && m.window === 'month');
      expect(month).toMatchObject({
        used: 100_000,
        limit: 1_000_000,
        remaining: 900_000,
        usedBdt: 12.3,
        blocked: false,
      });
      const institution = result.meters.filter((m) => m.meter === 'institution');
      expect(institution).toHaveLength(2);
      for (const meter of institution) {
        expect(meter).toMatchObject({ used: null, limit: null, remaining: null, blocked: false });
      }
    });
  });

  describe('warnings and repair', () => {
    beforeEach(async () => {
      await createPackage('pool', 10_000_000);
      await createPackage('member', 1_000);
    });

    it("warns against the weekly bucket's own window", async () => {
      const first = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 300,
      });
      const week = quota.getCalendarWeekRange(quota.QUOTA_RESET_TIMEZONE);
      const warnings = await models.UsageWarning.find({ scopeType: 'member_credits' }).lean();
      expect(warnings.map((w) => w.threshold).sort()).toEqual([0.8]);
      expect(warnings[0].periodStart.toISOString()).toBe(week.start.toISOString());
      expect(warnings[0].limit).toBe(350);
    });

    it('rebuilds weekly and monthly credit buckets from the reservations', async () => {
      const first = await reserve();
      await quota.settleUsage({
        tenantId,
        reservationKey: first.reservation.reservationKey,
        credits: 200,
      });
      await models.UsageBucket.updateMany(
        { scopeType: { $in: ['member_credits', 'institution_credits'] } },
        { $set: { usedTokens: 0 } },
      );
      const result = await quota.reconcileQuotaState({ now: new Date() });
      expect(result.repairedCreditWindows).toBe(2);
      const buckets = await models.UsageBucket.find({
        scopeType: { $in: ['member_credits', 'institution_credits'] },
      }).lean();
      expect(buckets).toHaveLength(4);
      for (const repaired of buckets) {
        expect(repaired.usedTokens).toBe(200);
      }
    });
  });
});
