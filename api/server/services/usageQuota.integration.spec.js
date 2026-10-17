const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

describe('usageQuota reservations (replica set)', () => {
  let replSet;
  let models;
  let quota;
  let usagePolicy;
  const tenantId = 'quota-integration';
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    usagePolicy = require('./usagePolicy');
    await Promise.all([
      models.Institution.syncIndexes(),
      models.UsagePolicy.syncIndexes(),
      models.UsageBucket.syncIndexes(),
      models.UsageReservation.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      models.Institution.deleteMany({}),
      models.UsagePolicy.deleteMany({}),
      models.UsageBucket.deleteMany({}),
      models.UsageReservation.deleteMany({}),
    ]);
    await models.Institution.create({
      tenantId,
      name: 'Quota Integration',
      timezone: 'Asia/Dhaka',
      usagePolicyVersion: 1,
    });
    await models.UsagePolicy.create({
      tenantId,
      version: 1,
      mode: 'enforce',
      timezone: 'Asia/Dhaka',
      limits: {
        institutionTokens: 700,
        memberTokens: null,
        modelTokens: [{ modelKey: 'gpt-4o', maxTokens: 700 }],
      },
      inputSafetyFactor: 1,
      inputSafetyTokens: 0,
      effectiveAt: new Date(),
      reason: 'integration test',
    });
  });

  it('allows only one concurrent final-capacity reservation', async () => {
    const request = (reservationKey) =>
      quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey,
        estimatedInputTokens: 100,
        requestedOutputTokens: 400,
      });

    const results = await Promise.allSettled([request('call-a'), request('call-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected.reason).toEqual(
      expect.objectContaining({
        statusCode: 429,
        body: { error: expect.objectContaining({ code: 'TOKEN_QUOTA_EXCEEDED' }) },
      }),
    );
  });

  it('replays a reservation idempotently and settles it only once', async () => {
    const input = {
      tenantId,
      userId,
      provider: 'openai',
      model: 'openai/gpt-4o',
      reservationKey: 'same-call',
      estimatedInputTokens: 100,
      requestedOutputTokens: 200,
    };
    const first = await quota.reserveUsage(input);
    const replay = await quota.reserveUsage(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(String(replay.reservation._id)).toBe(String(first.reservation._id));

    await Promise.all([
      quota.settleUsage({
        tenantId,
        reservationKey: input.reservationKey,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      quota.settleUsage({
        tenantId,
        reservationKey: input.reservationKey,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ]);

    const bucket = await models.UsageBucket.findOne({
      tenantId,
      scopeType: 'institution',
      scopeKey: tenantId,
    }).lean();
    expect(bucket.usedTokens).toBe(150);
    expect(bucket.reservedTokens).toBe(0);
  });

  it('requires explicit acknowledgement when a lower version blocks current usage', async () => {
    const range = quota.getCalendarMonthRange('Asia/Dhaka');
    await models.UsageBucket.create({
      tenantId,
      periodStart: range.start,
      periodEnd: range.end,
      scopeType: 'institution',
      scopeKey: tenantId,
      policyVersion: 1,
      usedTokens: 600,
      reservedTokens: 0,
    });
    const input = {
      mode: 'shadow',
      timezone: 'Asia/Dhaka',
      limits: {
        institutionTokens: 500,
        memberTokens: null,
        modelTokens: [],
      },
      warningThresholds: [0.8, 0.9],
    };

    await expect(
      usagePolicy.createUsagePolicy({
        tenantId,
        expectedVersion: 1,
        input,
        actorId: userId,
        reason: 'Lower pilot allocation',
        acknowledgeOverage: false,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'POLICY_OVERAGE_ACKNOWLEDGEMENT_REQUIRED' }));

    const result = await usagePolicy.createUsagePolicy({
      tenantId,
      expectedVersion: 1,
      input,
      actorId: userId,
      reason: 'Lower pilot allocation',
      acknowledgeOverage: true,
    });
    expect(result.policy.version).toBe(2);
    expect(result.policy.limits.institutionTokens).toBe(500);
    expect((await models.Institution.findOne({ tenantId }).lean()).usagePolicyVersion).toBe(2);
  });

  describe('weighted tokens and the image meter', () => {
    /** Weekly + monthly windows, a weighted endpoint, and an image allowance. */
    const seedPlanPolicy = async () => {
      await models.UsagePolicy.deleteMany({});
      await models.UsageBucket.deleteMany({});
      await models.UsageReservation.deleteMany({});
      await models.Institution.updateOne({ tenantId }, { $set: { usagePolicyVersion: 2 } });
      await models.UsagePolicy.create({
        tenantId,
        version: 2,
        mode: 'enforce',
        timezone: 'Asia/Dhaka',
        period: ['calendar_month', 'calendar_week'],
        limits: {
          institutionTokens: null,
          memberTokens: 10_000,
          memberTokensWeekly: 3_000,
          memberImages: 3,
          memberImagesWeekly: 2,
          modelTokens: [],
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'plan test',
      });
    };

    const memberBuckets = async (scopeType = 'member') =>
      models.UsageBucket.find({ tenantId, scopeType, scopeKey: String(userId) })
        .sort({ periodStart: 1 })
        .lean();

    beforeEach(seedPlanPolicy);

    it('reserves against both the weekly and the monthly window', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        endpoint: 'OpenAI',
        model: 'gpt-4o',
        reservationKey: 'two-windows',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      const buckets = await memberBuckets();
      expect(buckets).toHaveLength(2);
      for (const bucket of buckets) {
        expect(bucket.reservedTokens).toBe(200);
      }
    });

    it('doubles direct Claude but leaves the Office Assistant unweighted', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'Claude',
        model: 'claude-haiku-4-5',
        reservationKey: 'direct-claude',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      const direct = await models.UsageReservation.findOne({
        tenantId,
        reservationKey: 'direct-claude',
      }).lean();
      expect(direct.weight).toBe(2);
      expect(direct.reservedTokens).toBe(400);

      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'agent-claude',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      const viaAgent = await models.UsageReservation.findOne({
        tenantId,
        reservationKey: 'agent-claude',
      }).lean();
      expect(viaAgent.weight).toBe(1);
      expect(viaAgent.reservedTokens).toBe(200);
    });

    it('settles direct Claude at the weight it reserved with', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'Claude',
        model: 'claude-haiku-4-5',
        reservationKey: 'settle-weighted',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'settle-weighted',
        usage: { inputTokens: 300, outputTokens: 200 },
      });
      const buckets = await memberBuckets();
      for (const bucket of buckets) {
        expect(bucket.usedTokens).toBe(1000);
        expect(bucket.reservedTokens).toBe(0);
      }
    });

    /** A policy edit between reserve and settle must not settle against a
     *  different weight than it reserved, or the bucket drifts permanently. */
    it('ignores a weight change that lands mid-request', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'Claude',
        model: 'claude-haiku-4-5',
        reservationKey: 'mid-flight',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      await models.UsageReservation.updateOne(
        { tenantId, reservationKey: 'mid-flight' },
        { $set: { weight: 5 } },
      );
      await quota.settleUsage({
        tenantId,
        reservationKey: 'mid-flight',
        usage: { inputTokens: 100, outputTokens: 0 },
      });
      const buckets = await memberBuckets();
      expect(buckets[0].usedTokens).toBe(500);
    });

    it('counts an image as one unit and never touches the token buckets', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openrouter',
        endpoint: 'OpenRouter Image',
        model: 'x-ai/grok-imagine-image-2.0',
        reservationKey: 'one-image',
        estimatedInputTokens: 4175,
        requestedOutputTokens: 4175,
      });
      const reservation = await models.UsageReservation.findOne({
        tenantId,
        reservationKey: 'one-image',
      }).lean();
      expect(reservation.unit).toBe('images');
      expect(reservation.reservedTokens).toBe(1);

      const imageBuckets = await memberBuckets('member_images');
      expect(imageBuckets).toHaveLength(2);
      expect(imageBuckets.every((bucket) => bucket.reservedTokens === 1)).toBe(true);
      expect(await memberBuckets('member')).toHaveLength(0);
    });

    it('blocks the third image in a week that allows two', async () => {
      for (const key of ['img-1', 'img-2']) {
        await quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openrouter',
          endpoint: 'OpenRouter Image',
          model: 'x-ai/grok-imagine-image-2.0',
          reservationKey: key,
          estimatedInputTokens: 10,
          requestedOutputTokens: 10,
        });
        await quota.settleUsage({ tenantId, reservationKey: key, usage: {}, images: 1 });
      }
      await expect(
        quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openrouter',
          endpoint: 'OpenRouter Image',
          model: 'x-ai/grok-imagine-image-2.0',
          reservationKey: 'img-3',
          estimatedInputTokens: 10,
          requestedOutputTokens: 10,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          details: expect.objectContaining({ code: 'TOKEN_QUOTA_EXCEEDED' }),
        }),
      );
      /** The token meter is untouched, so document work still runs. */
      expect(await memberBuckets('member')).toHaveLength(0);
    });

    it('denies once the weekly window is exhausted while the month still has room', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        endpoint: 'OpenAI',
        model: 'gpt-4o',
        reservationKey: 'burn-week',
        estimatedInputTokens: 1500,
        requestedOutputTokens: 1500,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'burn-week',
        usage: { inputTokens: 1500, outputTokens: 1500 },
      });
      await expect(
        quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openai',
          endpoint: 'OpenAI',
          model: 'gpt-4o',
          reservationKey: 'over-week',
          estimatedInputTokens: 100,
          requestedOutputTokens: 100,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          details: expect.objectContaining({ code: 'TOKEN_QUOTA_EXCEEDED' }),
        }),
      );
      const buckets = await memberBuckets();
      const monthly = buckets.find((bucket) => bucket.usedTokens === 3000);
      expect(monthly).toBeDefined();
    });

    /** `null` is how an unlimited override and shadow mode both stay observable:
     *  usage is still recorded, it simply never denies. */
    it('records usage but never denies when the limit is null', async () => {
      await models.UsagePolicy.updateOne(
        { tenantId, version: 2 },
        { $set: { 'limits.memberTokensWeekly': null, 'limits.memberTokens': null } },
      );
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        endpoint: 'OpenAI',
        model: 'gpt-4o',
        reservationKey: 'unlimited',
        estimatedInputTokens: 999_999,
        requestedOutputTokens: 999_999,
      });
      const buckets = await memberBuckets();
      expect(buckets).toHaveLength(2);
      expect(buckets[0].reservedTokens).toBeGreaterThan(0);
    });
  });

  describe('getMemberQuota', () => {
    beforeEach(async () => {
      await models.UsagePolicy.deleteMany({});
      await models.UsageBucket.deleteMany({});
      await models.UsageReservation.deleteMany({});
      await models.Institution.updateOne({ tenantId }, { $set: { usagePolicyVersion: 5 } });
      await models.UsagePolicy.create({
        tenantId,
        version: 5,
        mode: 'enforce',
        timezone: 'Asia/Dhaka',
        period: ['calendar_month', 'calendar_week'],
        limits: {
          institutionTokens: null,
          memberTokens: 12_000_000,
          memberTokensWeekly: 3_000_000,
          memberImages: 30,
          memberImagesWeekly: 10,
          modelTokens: [],
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'quota summary test',
      });
    });

    const meterFor = (summary, meter, window) =>
      summary.meters.find((entry) => entry.meter === meter && entry.window === window);

    it('reports both meters across both windows', async () => {
      const summary = await quota.getMemberQuota({ tenantId, userId });
      expect(summary.meters).toHaveLength(4);
      expect(meterFor(summary, 'tokens', 'month').limit).toBe(12_000_000);
      expect(meterFor(summary, 'tokens', 'week').limit).toBe(3_000_000);
      expect(meterFor(summary, 'images', 'month').limit).toBe(30);
      expect(meterFor(summary, 'images', 'week').limit).toBe(10);
      expect(summary.enforced).toBe(true);
      expect(summary.unit).toBe('billing_tokens');
    });

    it('counts weighted usage, not raw tokens', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'Claude',
        model: 'claude-haiku-4-5',
        reservationKey: 'summary-weighted',
        estimatedInputTokens: 500,
        requestedOutputTokens: 500,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'summary-weighted',
        usage: { inputTokens: 500, outputTokens: 500 },
      });
      const weekly = meterFor(await quota.getMemberQuota({ tenantId, userId }), 'tokens', 'week');
      expect(weekly.used).toBe(2000);
      expect(weekly.remaining).toBe(3_000_000 - 2000);
      expect(weekly.blocked).toBe(false);
    });

    it('reports images on their own meter', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'summary-image',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'summary-image',
        usage: { inputTokens: 100, outputTokens: 100 },
        images: 3,
      });
      const summary = await quota.getMemberQuota({ tenantId, userId });
      expect(meterFor(summary, 'images', 'week').used).toBe(3);
      expect(meterFor(summary, 'images', 'week').remaining).toBe(7);
    });

    it('resets each window on its own boundary', async () => {
      const summary = await quota.getMemberQuota({ tenantId, userId });
      const week = new Date(meterFor(summary, 'tokens', 'week').resetsAt);
      const month = new Date(meterFor(summary, 'tokens', 'month').resetsAt);
      expect(week.getUTCDay()).toBe(1);
      expect(month.getUTCDate()).toBe(1);
      expect(week.getTime()).toBeLessThanOrEqual(month.getTime());
    });

    /** An unlimited override reports usage with no ceiling rather than hiding it. */
    it('marks a null limit unlimited while still reporting usage', async () => {
      await models.UsagePolicy.updateOne(
        { tenantId, version: 5 },
        { $set: { 'limits.memberTokensWeekly': null } },
      );
      const weekly = meterFor(await quota.getMemberQuota({ tenantId, userId }), 'tokens', 'week');
      expect(weekly.unlimited).toBe(true);
      expect(weekly.limit).toBeNull();
      expect(weekly.remaining).toBeNull();
      expect(weekly.blocked).toBe(false);
    });
  });

  describe('hard wall denials name the limit and its reset', () => {
    const seed = async (limits) => {
      await models.UsagePolicy.deleteMany({});
      await models.UsageBucket.deleteMany({});
      await models.UsageReservation.deleteMany({});
      await models.Institution.updateOne({ tenantId }, { $set: { usagePolicyVersion: 4 } });
      await models.UsagePolicy.create({
        tenantId,
        version: 4,
        mode: 'enforce',
        timezone: 'Asia/Dhaka',
        period: ['calendar_month', 'calendar_week'],
        limits: {
          institutionTokens: null,
          modelTokens: [],
          ...limits,
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'denial test',
      });
    };

    const denial = async (overrides = {}) => {
      try {
        await quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openai',
          endpoint: 'OpenAI',
          model: 'gpt-4o',
          reservationKey: `deny-${Math.random()}`,
          estimatedInputTokens: 1000,
          requestedOutputTokens: 1000,
          ...overrides,
        });
      } catch (error) {
        return error.details;
      }
      throw new Error('expected a quota denial');
    };

    it('names the weekly token wall and when it lifts', async () => {
      await seed({ memberTokens: 1_000_000, memberTokensWeekly: 10 });
      const details = await denial();
      expect(details.limitCode).toBe('WEEKLY_CAP');
      expect(details.window).toBe('week');
      expect(details.meter).toBe('tokens');
      /** UTC weeks turn over on a Monday, so the reset instant always does too. */
      expect(new Date(details.resetAt).getUTCDay()).toBe(1);
      expect(new Date(details.resetAt).getUTCHours()).toBe(0);
      expect(new Date(details.resetAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('names the monthly token wall when the month is the binding one', async () => {
      await seed({ memberTokens: 10, memberTokensWeekly: 1_000_000 });
      const details = await denial();
      expect(details.limitCode).toBe('MONTHLY_CAP');
      expect(details.window).toBe('month');
      expect(new Date(details.resetAt).getUTCDate()).toBe(1);
    });

    /** Regression: the binding scope was chosen by LIMIT SIZE, so a nearly-spent
     *  weekly window under a roomy monthly one reported MONTHLY_CAP and a reset
     *  three weeks away — telling the user to wait far longer than they must. */
    it('reports the week when the week is spent but the month is roomy', async () => {
      await seed({ memberTokens: 12_000_000, memberTokensWeekly: 3_000_000 });
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        endpoint: 'OpenAI',
        model: 'gpt-4o',
        reservationKey: 'burn-the-week',
        estimatedInputTokens: 1_499_500,
        requestedOutputTokens: 1_499_500,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'burn-the-week',
        usage: { inputTokens: 1_499_500, outputTokens: 1_499_500 },
      });
      const details = await denial({ estimatedInputTokens: 2000, requestedOutputTokens: 2000 });
      expect(details.limitCode).toBe('WEEKLY_CAP');
      expect(details.window).toBe('week');
      expect(new Date(details.resetAt).getUTCDay()).toBe(1);
    });

    it('names the image wall separately from the token wall', async () => {
      await seed({ memberTokens: 1_000_000, memberTokensWeekly: 1_000_000, memberImagesWeekly: 0 });
      const details = await denial({
        provider: 'openrouter',
        endpoint: 'OpenRouter Image',
        model: 'x-ai/grok-imagine-image-2.0',
      });
      expect(details.limitCode).toBe('IMAGE_WEEKLY_CAP');
      expect(details.meter).toBe('images');
    });

    /** The wall must stay fail-closed: a refusal the caller does not recognise
     *  would be treated as an availability blip and the request would proceed. */
    it('still reports as an enforcement denial', async () => {
      await seed({ memberTokens: 1_000_000, memberTokensWeekly: 10 });
      try {
        await quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openai',
          endpoint: 'OpenAI',
          model: 'gpt-4o',
          reservationKey: 'deny-fail-closed',
          estimatedInputTokens: 1000,
          requestedOutputTokens: 1000,
        });
        throw new Error('expected a quota denial');
      } catch (error) {
        expect(quota.isEnforcementDenial(error)).toBe(true);
        expect(error.details.code).toBe('TOKEN_QUOTA_EXCEEDED');
        expect(error.statusCode).toBe(429);
      }
    });

    /** An exhausted image allowance must not stop document work. */
    it('leaves the token meter usable when only images are exhausted', async () => {
      await seed({ memberTokens: 1_000_000, memberTokensWeekly: 1_000_000, memberImagesWeekly: 0 });
      await expect(
        quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openai',
          endpoint: 'OpenAI',
          model: 'gpt-4o',
          reservationKey: 'text-still-works',
          estimatedInputTokens: 100,
          requestedOutputTokens: 100,
        }),
      ).resolves.toEqual(expect.objectContaining({ reservation: expect.any(Object) }));
    });
  });

  describe('images generated through the Office Assistant', () => {
    const memberBuckets = async (scopeType) =>
      models.UsageBucket.find({ tenantId, scopeType, scopeKey: String(userId) })
        .sort({ periodStart: 1 })
        .lean();

    beforeEach(async () => {
      await models.UsagePolicy.deleteMany({});
      await models.UsageBucket.deleteMany({});
      await models.UsageReservation.deleteMany({});
      await models.Institution.updateOne({ tenantId }, { $set: { usagePolicyVersion: 3 } });
      await models.UsagePolicy.create({
        tenantId,
        version: 3,
        mode: 'enforce',
        timezone: 'Asia/Dhaka',
        period: ['calendar_month', 'calendar_week'],
        limits: {
          institutionTokens: null,
          memberTokens: 100_000,
          memberTokensWeekly: 50_000,
          memberImages: 30,
          memberImagesWeekly: 10,
          modelTokens: [],
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'agent image test',
      });
    });

    /** The reservation is made on `agents` before any subagent picks a model, so
     *  a delegated image can only reach the image meter at settlement. */
    it('charges a delegated image to the image meter, not the token meter', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'agent-with-image',
        estimatedInputTokens: 2000,
        requestedOutputTokens: 2000,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'agent-with-image',
        usage: { inputTokens: 2000, outputTokens: 500 },
        images: 1,
      });

      const imageBuckets = await memberBuckets('member_images');
      expect(imageBuckets).toHaveLength(2);
      expect(imageBuckets.every((bucket) => bucket.usedTokens === 1)).toBe(true);

      /** Only the text tokens landed on the token meter — the image's ~4,175
       *  tokens were excluded upstream by `splitImageUsage`. */
      const tokenBuckets = await memberBuckets('member');
      expect(tokenBuckets.every((bucket) => bucket.usedTokens === 2500)).toBe(true);
    });

    it('does not double-count when a settlement is replayed', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'replayed',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      const settle = () =>
        quota.settleUsage({
          tenantId,
          reservationKey: 'replayed',
          usage: { inputTokens: 100, outputTokens: 100 },
          images: 2,
        });
      await settle();
      await settle();
      const imageBuckets = await memberBuckets('member_images');
      expect(imageBuckets.every((bucket) => bucket.usedTokens === 2)).toBe(true);
    });

    it('leaves the image meter alone for a run that generated none', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'no-images',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'no-images',
        usage: { inputTokens: 100, outputTokens: 100 },
        images: 0,
      });
      expect(await memberBuckets('member_images')).toHaveLength(0);
    });

    /** Accepted overshoot: the count is unknowable until the run completes, so a
     *  request that lands on the last of the allowance may exceed it once. */
    it('lets a run that lands on the limit overshoot, then blocks the next', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'anthropic',
        endpoint: 'agents',
        model: 'claude-haiku-4-5',
        reservationKey: 'overshoot',
        estimatedInputTokens: 100,
        requestedOutputTokens: 100,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'overshoot',
        usage: { inputTokens: 100, outputTokens: 100 },
        images: 12,
      });
      const weekly = (await memberBuckets('member_images')).find(
        (bucket) => bucket.usedTokens === 12,
      );
      expect(weekly).toBeDefined();

      await expect(
        quota.reserveUsage({
          tenantId,
          userId,
          provider: 'openrouter',
          endpoint: 'OpenRouter Image',
          model: 'x-ai/grok-imagine-image-2.0',
          reservationKey: 'after-overshoot',
          estimatedInputTokens: 10,
          requestedOutputTokens: 10,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          details: expect.objectContaining({ code: 'TOKEN_QUOTA_EXCEEDED' }),
        }),
      );
    });
  });

  describe('reconciliation', () => {
    it('settles a reservation that outran its TTL instead of dropping the usage', async () => {
      const reservationKey = 'late-settle';
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey,
        estimatedInputTokens: 100,
        requestedOutputTokens: 200,
      });

      await models.UsageReservation.updateOne(
        { tenantId, reservationKey },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await quota.reconcileExpiredReservations({ limit: 10 });
      expect(
        (await models.UsageReservation.findOne({ tenantId, reservationKey }).lean()).status,
      ).toBe('expired');

      await quota.settleUsage({
        tenantId,
        reservationKey,
        usage: { inputTokens: 120, outputTokens: 60 },
      });

      const reservation = await models.UsageReservation.findOne({
        tenantId,
        reservationKey,
      }).lean();
      expect(reservation.status).toBe('settled');
      expect(reservation.actualTokens).toBe(180);

      const bucket = await models.UsageBucket.findOne({
        tenantId,
        scopeType: 'institution',
        scopeKey: tenantId,
      }).lean();
      expect(bucket.usedTokens).toBe(180);
      expect(bucket.reservedTokens).toBe(0);
    });

    it('preserves capacity held by an in-flight reservation while repairing totals', async () => {
      await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'settled-call',
        estimatedInputTokens: 50,
        requestedOutputTokens: 50,
      });
      await quota.settleUsage({
        tenantId,
        reservationKey: 'settled-call',
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      const inFlight = await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'in-flight-call',
        estimatedInputTokens: 60,
        requestedOutputTokens: 40,
      });

      await quota.reconcileQuotaState({ limit: 50 });

      const bucket = await models.UsageBucket.findOne({
        tenantId,
        scopeType: 'institution',
        scopeKey: tenantId,
      }).lean();
      expect(bucket.usedTokens).toBe(75);
      expect(bucket.reservedTokens).toBe(inFlight.reservation.reservedTokens);
    });
  });

  describe('shadow mode', () => {
    beforeEach(async () => {
      await models.UsagePolicy.deleteMany({ tenantId });
      await models.UsagePolicy.create({
        tenantId,
        version: 1,
        mode: 'shadow',
        timezone: 'Asia/Dhaka',
        limits: {
          institutionTokens: 700,
          memberTokens: null,
          modelTokens: [{ modelKey: 'gpt-4o', maxTokens: 700 }],
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'shadow integration test',
      });
    });

    it('never caps output, even when the request exceeds every limit', async () => {
      const result = await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-uncapped',
        estimatedInputTokens: 5000,
        requestedOutputTokens: 100000,
      });

      expect(result.outputTokenCap).toBeNull();
      expect(result.outputCapped).toBe(false);
    });

    it('records observed usage without capping when no output limit was requested', async () => {
      const result = await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-default',
        estimatedInputTokens: 10,
      });

      expect(result.outputTokenCap).toBeNull();
      expect(result.reservation.reservedTokens).toBeGreaterThan(0);
    });

    it('keeps the cap absent on an idempotent replay', async () => {
      const input = {
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-replay',
        estimatedInputTokens: 10,
        requestedOutputTokens: 100000,
      };
      await quota.reserveUsage(input);
      const replay = await quota.reserveUsage(input);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.outputTokenCap).toBeNull();
    });
  });
});
