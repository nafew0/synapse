const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { INDIVIDUAL_USAGE_ACCOUNT } = require('@librechat/data-schemas');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

/** GPT-5.6 Luna on OpenRouter: 0.2 credits per input token, 1.2 per output token. */
const LUNA = {
  model: 'openai/gpt-5.6-luna',
  endpoint: 'OpenRouter',
  rates: { input: 0.2, output: 1.2 },
};

describe('usageQuota for users outside any institution (replica set)', () => {
  let replSet;
  let models;
  let quota;
  let usagePolicy;
  let usageCatalog;
  const tenantId = INDIVIDUAL_USAGE_ACCOUNT;
  const userId = new mongoose.Types.ObjectId();
  let sequence = 0;

  const bdtFor = (credits) => (credits / 1e6) * 123;

  const createPackage = (key, monthlyCredits) =>
    models.UsagePackage.create({
      key,
      name: key,
      scopes: ['member'],
      price: 0,
      monthlyCredit: bdtFor(monthlyCredits),
    });

  const reserve = (overrides = {}) =>
    quota.reserveUsage({
      tenantId,
      userId,
      provider: 'openrouter',
      endpoint: 'agents',
      model: 'agent_office_assistant',
      reservationKey: `individual-call-${(sequence += 1)}`,
      pricingContext: LUNA,
      estimatedInputTokens: 100,
      requestedOutputTokens: 400,
      ...overrides,
    });

  /** The individuals account with a trial package, enforced from its first policy. */
  const configureTrial = async (trialCredits = 1_000_000) => {
    await createPackage('trial', trialCredits);
    await models.UsageAccount.create({
      tenantId,
      name: 'Individuals',
      usagePolicyVersion: 1,
      usagePackage: { packageKey: null, memberPackageKey: 'trial' },
    });
    await models.UsagePolicy.create({
      tenantId,
      version: 1,
      mode: 'enforce',
      timezone: 'UTC',
      limits: {},
      inputSafetyFactor: 1,
      inputSafetyTokens: 0,
      effectiveAt: new Date(),
      reason: 'individuals test',
    });
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    usagePolicy = require('./usagePolicy');
    usageCatalog = require('./usageCatalog');
    await Promise.all(
      ['UsageAccount', 'UsagePolicy', 'UsageBucket', 'UsageReservation', 'UsagePackage'].map(
        (name) => models[name].syncIndexes(),
      ),
    );
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
        'UsageAccount',
        'UsagePolicy',
        'UsageBucket',
        'UsageReservation',
        'UsageWarning',
        'UsagePackage',
        'UsagePricing',
        'User',
        'Transaction',
        'PlatformAdmin',
      ].map((name) => models[name].deleteMany({})),
    );
  });

  /** The only test that resolves accounts, so the platform-staff cache is loaded here first. */
  it('meters standalone users, never platform staff, and institution members by institution', async () => {
    const boundStaff = await models.User.create({
      email: 'staff@example.test',
      accountScope: 'standalone',
    });
    await models.PlatformAdmin.create({ email: 'staff@example.test', userId: boundStaff._id });
    await models.PlatformAdmin.create({ email: 'unbound@example.test' });
    await models.PlatformAdmin.create({ email: 'former@example.test', active: false });
    const standalone = (email) => ({
      id: String(new mongoose.Types.ObjectId()),
      email,
      accountScope: 'standalone',
    });

    expect(
      await quota.resolveQuotaAccount({ ...standalone('x'), id: String(boundStaff._id) }),
    ).toBeNull();
    expect(await quota.resolveQuotaAccount(standalone('Unbound@example.test'))).toBeNull();
    expect(await quota.resolveQuotaAccount(standalone('former@example.test'))).toBe(tenantId);
    expect(await quota.resolveQuotaAccount(standalone('solo@example.test'))).toBe(tenantId);
    expect(
      await quota.resolveQuotaAccount({ id: 'm', tenantId: 'uni', accountScope: 'institution' }),
    ).toBe('uni');
  });

  it('meters nothing until the account is given a trial package', async () => {
    expect(await reserve()).toBeNull();
    expect(await quota.getMemberQuota({ tenantId, userId })).toBeNull();
    expect(await models.UsageBucket.countDocuments({})).toBe(0);
  });

  it('meters an individual on the trial package, with no shared pool', async () => {
    await configureTrial();
    const { reservation } = await reserve();
    expect(reservation.metadata.memberPackageKey).toBe('trial');
    expect(reservation.scopes.map((scope) => `${scope.scopeType}:${scope.window}`)).toEqual([
      'member_credits:month',
      'member_credits:week',
    ]);
    expect(await models.UsageBucket.countDocuments({ scopeType: 'institution_credits' })).toBe(0);
  });

  it('refuses at the trial week, and the individual’s own package lifts it', async () => {
    /** 35% of 1,000 credits: 350 a week, less than this request's 400 input credits alone. */
    await configureTrial(1_000);
    await expect(reserve({ estimatedInputTokens: 2_000 })).rejects.toMatchObject({
      details: expect.objectContaining({ limitCode: 'WEEKLY_CAP', window: 'week' }),
    });
    await createPackage('plus', 10_000_000);
    usageCatalog.invalidate();
    const { reservation } = await reserve({ memberPackage: { packageKey: 'plus' } });
    expect(reservation.metadata.memberPackageKey).toBe('plus');
  });

  it('shows the individuals without a pool, busiest first', async () => {
    await configureTrial();
    const quiet = await models.User.create({
      name: 'Quiet',
      email: 'quiet@example.test',
      accountScope: 'standalone',
    });
    const busy = await models.User.create({
      name: 'Busy',
      email: 'busy@example.test',
      accountScope: 'standalone',
    });
    const spend = async (user, credits) => {
      const { reservation } = await reserve({ userId: user._id });
      await quota.settleUsage({
        tenantId,
        reservationKey: reservation.reservationKey,
        credits,
        usage: { inputTokens: 100, outputTokens: 10 },
      });
    };
    await spend(quiet, 50);
    await spend(busy, 400);
    const console = await quota.getCreditConsole({ tenantId });
    expect(console).toMatchObject({
      pooled: false,
      institution: null,
      memberTotal: 2,
      defaultMemberPackage: 'trial',
    });
    expect(console.members.map((member) => member.name)).toEqual(['Busy', 'Quiet']);
    expect(console.members[0]).toMatchObject({ week: { used: 400 }, month: { used: 400 } });
  });

  it('creates the account with its first policy and counts it as enforcing', async () => {
    const { policy } = await usagePolicy.createUsagePolicy({
      tenantId,
      expectedVersion: 0,
      input: { mode: 'enforce' },
      actorId: new mongoose.Types.ObjectId(),
      reason: 'turn on individuals',
    });
    expect(policy).toMatchObject({ tenantId, version: 1, mode: 'enforce' });
    expect(await models.UsageAccount.findOne({ tenantId }).lean()).toMatchObject({
      name: 'Individuals',
      usagePolicyVersion: 1,
    });
    expect(await models.Institution.countDocuments({})).toBe(0);
    expect(await quota.assertEnforcementTopology()).toMatchObject({ enforcing: true });
  });

  it('counts only individuals’ billed calls in the shadow gate, not platform staff', async () => {
    const individual = await models.User.create({
      email: 'solo@example.test',
      accountScope: 'standalone',
    });
    const staff = await models.User.create({ email: 'staff@example.test' });
    const call = (user, messageId) => ({
      user: user._id,
      context: 'message',
      conversationId: 'conv',
      messageId,
      requestKey: `conv:${messageId}`,
      providerKey: 'openrouter',
      modelKey: 'openai/gpt-5.6-luna',
      tokenType: 'prompt',
      rawAmount: -10,
      tokenValue: -2,
      createdAt: new Date(),
    });
    await models.Transaction.collection.insertMany([
      call(individual, 'solo-1'),
      call(individual, 'solo-2'),
      call(staff, 'staff-1'),
      { ...call(individual, 'uni-1'), tenantId: 'uni' },
    ]);
    const { metrics } = await quota.getShadowReadiness({ tenantId });
    expect(metrics.ledgerCalls).toBe(2);
  });
});
