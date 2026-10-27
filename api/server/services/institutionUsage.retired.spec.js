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

/** Today's specs, as in librechat.yaml after the gpt-6-luna / claude-haiku-5.5 upgrade. */
const labelIndex = buildModelLabelIndex({
  modelSpecs: {
    list: [
      {
        name: 'gpt-6-luna',
        label: 'ChatGPT',
        preset: { endpoint: 'OpenRouter', model: 'openai/gpt-6-luna' },
      },
      {
        name: 'anthropic/claude-haiku-5.5',
        label: 'Claude',
        preset: { endpoint: 'OpenRouter', model: 'anthropic/claude-haiku-5.5' },
      },
      {
        name: 'google/gemini-3.8-flash',
        label: 'Google Gemini (Latest)',
        preset: { endpoint: 'OpenRouter', model: 'google/gemini-3.8-flash' },
      },
    ],
  },
});

const TENANT = 'tenant-retired';
const MEMBER = new mongoose.Types.ObjectId();

function transaction({ conversationId, model, providerKey, amount = 100 }) {
  return {
    user: MEMBER,
    tenantId: TENANT,
    conversationId,
    tokenType: 'completion',
    model,
    providerModelId: model,
    providerKey,
    rawAmount: -amount,
    tokenValue: -amount * 2,
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
    updatedAt: new Date('2026-09-15T10:00:00.000Z'),
  };
}

/**
 * Usage recorded before a model upgrade carries the old spec and model ids, often
 * spelled differently per provider route. It should count under the model members
 * picked, and anything no longer offered should collapse into one row.
 */
describe('institutionUsage renamed and retired models', () => {
  let mongoServer;
  let listUsageByModel;
  let getUsageSummary;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    ({ listUsageByModel, getUsageSummary } = require('./institutionUsage'));

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Retired Test', timezone: 'UTC' });
    await mongoose.connection.collection('conversations').insertMany([
      {
        conversationId: 'old-chatgpt',
        tenantId: TENANT,
        user: String(MEMBER),
        spec: 'gpt-5.6-luna',
      },
      {
        conversationId: 'old-claude',
        tenantId: TENANT,
        user: String(MEMBER),
        spec: 'claude-haiku-4-5',
      },
      { conversationId: 'old-glm', tenantId: TENANT, user: String(MEMBER), spec: 'z-ai-glm-5-2' },
      { conversationId: 'no-spec', tenantId: TENANT, user: String(MEMBER) },
    ]);
    await mongoose.connection.collection('transactions').insertMany([
      transaction({
        conversationId: 'old-chatgpt',
        model: 'openai/gpt-5.6-luna',
        providerKey: 'openrouter',
      }),
      transaction({ conversationId: 'no-spec', model: 'gpt-5.6-luna', providerKey: 'openai' }),
      transaction({
        conversationId: 'no-spec',
        model: 'openai/gpt-5.6-luna',
        providerKey: 'custom',
      }),
      transaction({
        conversationId: 'old-claude',
        model: 'claude-haiku-4-5',
        providerKey: 'anthropic',
      }),
      transaction({
        conversationId: 'no-spec',
        model: 'anthropic/claude-haiku-4.5',
        providerKey: 'agents',
      }),
      transaction({ conversationId: 'old-glm', model: 'z-ai/glm-5.2', providerKey: 'custom' }),
      transaction({ conversationId: 'no-spec', model: 'qwen3.8-27b', providerKey: 'openai' }),
      transaction({
        conversationId: 'no-spec',
        model: 'google/gemini-3.8-flash',
        providerKey: 'google',
      }),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const range = { tenantId: TENANT, start: '2026-09-01', end: '2026-09-30' };
  const superadmin = { index: labelIndex, restrictToLabeled: false };
  const institutionAdmin = { index: labelIndex, restrictToLabeled: true };
  const byName = (models) => new Map(models.map((row) => [row.displayName, row]));

  it('counts every spelling and the retired spec of a model under its current name', async () => {
    const { models } = await listUsageByModel({ ...range, limit: 100, labels: superadmin });
    const rows = byName(models);
    expect(rows.get('ChatGPT').eventCount).toBe(3);
    expect(rows.get('Claude').eventCount).toBe(2);
    expect(rows.get('Google Gemini (Latest)').eventCount).toBe(1);
  });

  it('collapses models no longer offered into one row for superadmins', async () => {
    const { models, total } = await listUsageByModel({ ...range, limit: 100, labels: superadmin });
    expect(total).toBe(4);
    expect(byName(models).get('Retired models')).toMatchObject({
      retired: true,
      modelKey: 'retired',
      retiredModelIds: ['glm-5.2', 'qwen3.8-27b'],
      eventCount: 2,
    });
  });

  it('keeps retired models out of the institution admin view and of "Models used"', async () => {
    const restricted = await listUsageByModel({ ...range, limit: 100, labels: institutionAdmin });
    expect(restricted.models.map((row) => row.displayName).sort()).toEqual([
      'ChatGPT',
      'Claude',
      'Google Gemini (Latest)',
    ]);
    const [admin, platform] = await Promise.all([
      getUsageSummary({ ...range, labels: institutionAdmin }),
      getUsageSummary({ ...range, labels: superadmin }),
    ]);
    expect(admin.summary.modelCount).toBe(3);
    expect(platform.summary.modelCount).toBe(3);
  });

  it('finds the retired row by an old model id', async () => {
    const { models } = await listUsageByModel({
      ...range,
      limit: 100,
      query: 'glm',
      labels: superadmin,
    });
    expect(models.map((row) => row.displayName)).toEqual(['Retired models']);
  });
});
