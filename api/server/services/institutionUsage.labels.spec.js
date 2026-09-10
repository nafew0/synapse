const mongoose = require('mongoose');
const { buildModelLabelIndex } = require('@librechat/api');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/services/usageQuota', () => ({
  getCalendarMonthRange: () => ({
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-10-01T00:00:00.000Z'),
    timezone: 'UTC',
  }),
  zonedDateTimeToUtc: ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)),
}));

const OFFICE_SPEC = {
  name: 'office-assistant',
  label: 'Office Assistant',
  preset: { endpoint: 'agents', agent_id: 'agent_office_assistant' },
};
const CLAUDE_SPEC = {
  name: 'claude-haiku-4-5',
  label: 'Claude',
  preset: { endpoint: 'Claude', model: 'claude-haiku-4-5' },
};

const labelIndex = buildModelLabelIndex({
  modelSpecs: { list: [OFFICE_SPEC, CLAUDE_SPEC] },
  agentModels: new Map([['agent_office_assistant', 'claude-haiku-4-5']]),
});

const TENANT = 'tenant-a';
const MEMBER = new mongoose.Types.ObjectId();
const OTHER_MEMBER = new mongoose.Types.ObjectId();

function transaction({
  conversationId,
  model,
  user = MEMBER,
  tokenType = 'completion',
  amount = 100,
}) {
  return {
    user,
    tenantId: TENANT,
    conversationId,
    tokenType,
    model,
    providerModelId: model,
    providerKey: 'anthropic',
    rawAmount: -amount,
    tokenValue: -amount * 2,
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
    updatedAt: new Date('2026-09-15T10:00:00.000Z'),
  };
}

describe('institutionUsage model labels', () => {
  let mongoServer;
  let listUsageByModel;
  let getUsageSummary;
  let getMemberUsageSummary;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    ({ listUsageByModel, getUsageSummary, getMemberUsageSummary } = require('./institutionUsage'));

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Test Institution', timezone: 'UTC' });

    await mongoose.connection.collection('conversations').insertMany([
      {
        conversationId: 'convo-office',
        user: String(MEMBER),
        tenantId: TENANT,
        spec: 'office-assistant',
      },
      {
        conversationId: 'convo-chat',
        user: String(MEMBER),
        tenantId: TENANT,
        spec: 'claude-haiku-4-5',
      },
      { conversationId: 'convo-title', user: String(MEMBER), tenantId: TENANT },
    ]);

    await mongoose.connection.collection('transactions').insertMany([
      transaction({ conversationId: 'convo-office', model: 'claude-haiku-4-5', amount: 500 }),
      transaction({
        conversationId: 'convo-office',
        model: 'claude-haiku-4-5',
        user: OTHER_MEMBER,
        amount: 300,
      }),
      transaction({ conversationId: 'convo-chat', model: 'claude-haiku-4-5', amount: 200 }),
      transaction({ conversationId: 'convo-title', model: 'claude-sonnet-4-5', amount: 90 }),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const range = { tenantId: TENANT, start: '2026-09-01', end: '2026-09-30' };

  it('splits one provider model into the two specs the members actually chose', async () => {
    const result = await listUsageByModel({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: true },
    });

    const byLabel = new Map(result.models.map((row) => [row.displayName, row]));
    expect([...byLabel.keys()].sort()).toEqual(['Claude', 'Office Assistant']);
    expect(byLabel.get('Office Assistant').totalTokens).toBe(800);
    expect(byLabel.get('Office Assistant').memberCount).toBe(2);
    expect(byLabel.get('Claude').totalTokens).toBe(200);
  });

  it('hides models with no UI label and reports the reduced total', async () => {
    const restricted = await listUsageByModel({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: true },
    });
    expect(restricted.total).toBe(2);
    expect(restricted.models.some((row) => row.modelKey === 'claude-sonnet-4-5')).toBe(false);

    const unrestricted = await listUsageByModel({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: false },
    });
    expect(unrestricted.total).toBe(3);
    expect(unrestricted.models.some((row) => row.modelKey === 'claude-sonnet-4-5')).toBe(true);
  });

  it('omits cost and provider for a restricted caller and keeps them otherwise', async () => {
    const restricted = await listUsageByModel({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: true },
    });
    for (const row of restricted.models) {
      expect(row).not.toHaveProperty('totalCost');
      expect(row).not.toHaveProperty('providerKey');
      expect(row.totalTokens).toBeGreaterThan(0);
    }

    const unrestricted = await listUsageByModel({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: false },
    });
    expect(unrestricted.models[0]).toHaveProperty('totalCost');
    expect(unrestricted.models[0]).toHaveProperty('providerKey');
  });

  it('searches models by the label shown in the UI', async () => {
    const result = await listUsageByModel({
      ...range,
      query: 'office',
      labels: { index: labelIndex, restrictToLabeled: true },
    });

    expect(result.total).toBe(1);
    expect(result.models[0].displayName).toBe('Office Assistant');
  });

  it('counts only labeled models in the summary so the card matches the table', async () => {
    const restricted = await getUsageSummary({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: true },
    });
    expect(restricted.summary.modelCount).toBe(2);
    expect(restricted.summary).not.toHaveProperty('totalCost');
    expect(restricted.summary.totalTokens).toBe(1090);

    const unrestricted = await getUsageSummary({
      ...range,
      labels: { index: labelIndex, restrictToLabeled: false },
    });
    expect(unrestricted.summary.modelCount).toBe(3);
    expect(unrestricted.summary).toHaveProperty('totalCost');
  });

  it('labels the per-member model breakdown the same way', async () => {
    const result = await getMemberUsageSummary({
      ...range,
      userId: String(MEMBER),
      labels: { index: labelIndex, restrictToLabeled: true },
    });

    const labels = result.models.map((row) => row.displayName).sort();
    expect(labels).toEqual(['Claude', 'Office Assistant']);
    expect(result.summary).not.toHaveProperty('totalCost');
    expect(result.models[0]).not.toHaveProperty('providerKey');
  });

  describe('zero-cost models', () => {
    const FREE_TENANT = 'tenant-free';
    const freeRange = { tenantId: FREE_TENANT, start: '2026-09-01', end: '2026-09-30' };

    beforeAll(async () => {
      await mongoose.connection
        .collection('institutions')
        .insertOne({ tenantId: FREE_TENANT, name: 'Free Institution', timezone: 'UTC' });
      await mongoose.connection.collection('conversations').insertMany([
        {
          conversationId: 'convo-paid',
          user: String(MEMBER),
          tenantId: FREE_TENANT,
          spec: 'claude-haiku-4-5',
        },
        {
          conversationId: 'convo-free',
          user: String(MEMBER),
          tenantId: FREE_TENANT,
          spec: 'office-assistant',
        },
      ]);
      await mongoose.connection.collection('transactions').insertMany([
        {
          ...transaction({ conversationId: 'convo-paid', model: 'claude-haiku-4-5', amount: 400 }),
          tenantId: FREE_TENANT,
        },
        {
          ...transaction({ conversationId: 'convo-free', model: 'free-model', amount: 700 }),
          tenantId: FREE_TENANT,
          tokenValue: 0,
        },
      ]);
    });

    it('drops models that used tokens but cost nothing from the billing table and its count', async () => {
      const labels = { index: labelIndex, restrictToLabeled: false };
      const table = await listUsageByModel({ ...freeRange, labels });
      expect(table.total).toBe(1);
      expect(table.models.map((row) => row.modelKey)).toEqual(['claude-haiku-4-5']);

      const { summary } = await getUsageSummary({ ...freeRange, labels });
      expect(summary.modelCount).toBe(1);
      expect(summary.totalTokens).toBe(1100);
    });

    it('keeps zero-cost usage for institution admins, who never see cost', async () => {
      const labels = { index: labelIndex, restrictToLabeled: true };
      const table = await listUsageByModel({ ...freeRange, labels });
      const byLabel = new Map(table.models.map((row) => [row.displayName, row]));
      expect([...byLabel.keys()].sort()).toEqual(['Claude', 'Office Assistant']);
      expect(byLabel.get('Office Assistant').totalTokens).toBe(700);

      const { summary } = await getUsageSummary({ ...freeRange, labels });
      expect(summary.modelCount).toBe(2);
    });
  });
});
