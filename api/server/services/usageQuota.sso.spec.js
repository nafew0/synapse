const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { INDIVIDUAL_USAGE_ACCOUNT } = require('@librechat/data-schemas');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

/** The signed-in user, read from the database on every request as the JWT strategy does. */
let mockSignedIn = null;
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: async (req, _res, next) => {
    const user = await require('~/db/models').User.findById(mockSignedIn).lean();
    req.user = { ...user, id: String(user._id) };
    next();
  },
}));

const mockAllowance = jest.fn();
jest.mock('~/server/services/bdrenAllowance', () => ({
  getRequestAllowance: (...args) => mockAllowance(...args),
}));

const ISSUER = 'https://auth.bdren.test';
const RATES = { model: 'test-model', endpoint: 'OpenRouter', rates: { input: 1, output: 1 } };

/** bdren.ai's Free answer for an individual: 100 credits a month, 35 a week. */
function freeAllowance() {
  const start = new Date('2026-11-15T04:00:00Z').getTime();
  const window = (days) => ({ start: new Date(start), end: new Date(start + days * 86_400_000) });
  return {
    origin: 'fresh',
    planSource: 'free',
    packageSlug: 'free',
    packageName: 'Free',
    packageVersion: 1,
    institutionId: null,
    institutionName: null,
    upgradeUrl: 'https://bdren.test/profile/billing',
    renews: 'monthly',
    subscriptionEndsAt: null,
    etag: 'e',
    member: {
      month: { limit: 100, window: window(30) },
      week: { limit: 35, window: window(7) },
    },
    institution: null,
  };
}

describe('a new BDREN SSO user with no institution (replica set)', () => {
  let replSet;
  let models;
  let quota;
  let server;
  let baseUrl;
  let ensureStandaloneScope;
  let sequence = 0;

  /** The account `processOpenIDAuth` creates for a first sign-in that names no institution. */
  async function firstSignIn(email) {
    sequence += 1;
    const created = await models.User.create({
      provider: 'openid',
      openidId: `sub-${sequence}`,
      openidIssuer: ISSUER,
      email,
      emailVerified: true,
      username: `sso${sequence}`,
      name: `SSO ${sequence}`,
    });
    await ensureStandaloneScope(created.toObject());
    return models.User.findById(created._id).lean();
  }

  const getQuota = async (user) => {
    mockSignedIn = user._id;
    return fetch(`${baseUrl}/api/quota`, { headers: { 'User-Agent': 'jest' } });
  };

  const reserveChat = (user, key) =>
    quota.reserveUsage({
      tenantId: INDIVIDUAL_USAGE_ACCOUNT,
      userId: user._id,
      provider: 'openrouter',
      endpoint: 'agents',
      model: 'agent_office_assistant',
      reservationKey: key,
      pricingContext: RATES,
      estimatedInputTokens: 20,
      requestedOutputTokens: 10,
      allowance: freeAllowance(),
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    ({ ensureStandaloneScope } = require('@librechat/api'));
    await Promise.all(
      ['UsageAccount', 'UsagePolicy', 'UsageBucket', 'UsageReservation', 'User'].map((name) =>
        models[name].syncIndexes(),
      ),
    );
    const app = express();
    app.use('/api/quota', require('~/server/routes/quota'));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    await mongoose.disconnect();
    await replSet?.stop();
  });

  beforeEach(async () => {
    mockAllowance.mockReset().mockImplementation(async () => freeAllowance());
    await Promise.all(
      [
        'UsageAccount',
        'UsagePolicy',
        'UsageBucket',
        'UsageReservation',
        'UsageWarning',
        'User',
        'PlatformAdmin',
      ].map((name) => models[name].deleteMany({})),
    );
    await models.UsageAccount.create({
      tenantId: INDIVIDUAL_USAGE_ACCOUNT,
      name: 'Individuals',
      usagePolicyVersion: 1,
    });
    await models.UsagePolicy.create({
      tenantId: INDIVIDUAL_USAGE_ACCOUNT,
      version: 1,
      timezone: 'UTC',
      limits: {},
      inputSafetyFactor: 1,
      inputSafetyTokens: 0,
      effectiveAt: new Date(),
      reason: 'sso test',
    });
  });

  it('is metered: /api/quota shows the Free meters and a used-up allowance refuses the chat', async () => {
    const user = await firstSignIn('free@example.test');
    expect(user.accountScope).toBe('standalone');

    const BaseClient = require('~/app/clients/BaseClient');
    const tenant = await BaseClient.prototype.resolveQuotaTenant.call({
      options: { req: { user: { ...user, id: String(user._id) } } },
    });
    expect(tenant).toBe(INDIVIDUAL_USAGE_ACCOUNT);

    const response = await getQuota(user);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      tenantId: INDIVIDUAL_USAGE_ACCOUNT,
      plan: { planSource: 'free', packageName: 'Free' },
    });
    expect(body.meters.map(({ window, limit, blocked }) => [window, limit, blocked])).toEqual([
      ['month', 100, false],
      ['week', 35, false],
    ]);

    const { reservation } = await reserveChat(user, 'first');
    await quota.settleUsage({
      tenantId: INDIVIDUAL_USAGE_ACCOUNT,
      reservationKey: reservation.reservationKey,
      usage: null,
      credits: 35,
    });
    await expect(reserveChat(user, 'second')).rejects.toMatchObject({
      name: 'QuotaError',
      details: expect.objectContaining({ limitCode: 'WEEKLY_CAP' }),
    });
  });

  it('leaves platform staff unmetered', async () => {
    await models.PlatformAdmin.create({ email: 'staff@example.test' });
    const staff = await firstSignIn('staff@example.test');
    expect(staff.accountScope).toBeUndefined();

    expect(await quota.resolveQuotaAccount({ ...staff, id: String(staff._id) })).toBeNull();
    expect((await getQuota(staff)).status).toBe(204);
  });
});
