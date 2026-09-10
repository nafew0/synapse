const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockGetAppConfig = jest.fn();

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

const modelSpecs = {
  list: [
    {
      name: 'office-assistant',
      label: 'Office Assistant',
      preset: { endpoint: 'agents', agent_id: 'agent_office_assistant' },
    },
    {
      name: 'gpt-5.6-luna',
      label: 'ChatGPT',
      preset: { endpoint: 'OpenRouter', model: 'openai/gpt-5.6-luna' },
    },
    {
      name: 'claude-haiku-4-5',
      label: 'Claude',
      preset: { endpoint: 'Claude', model: 'claude-haiku-4-5' },
    },
    {
      name: 'google/gemini-3.1-flash-image',
      label: 'Image Generation',
      preset: { endpoint: 'OpenRouter Image', model: 'google/gemini-3.1-flash-image' },
    },
    {
      name: 'missing-agent',
      label: 'Ghost',
      preset: { endpoint: 'agents', agent_id: 'agent_gone' },
    },
  ],
};

describe('getQuotaModelSources', () => {
  let mongoServer;
  let getQuotaModelSources;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    ({ getQuotaModelSources } = require('./usageLabels'));

    await mongoose.connection.collection('agents').insertOne({
      id: 'agent_office_assistant',
      name: 'Office Assistant',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      author: new mongoose.Types.ObjectId(),
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    mockGetAppConfig.mockResolvedValue({ modelSpecs });
  });

  it('keys every offered model the way the quota engine keys its bucket', async () => {
    const sources = await getQuotaModelSources('tenant-a');

    expect(sources).toEqual([
      { modelKey: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', label: 'Office Assistant' },
      { modelKey: 'gpt-5.6-luna', modelId: 'openai/gpt-5.6-luna', label: 'ChatGPT' },
      { modelKey: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', label: 'Claude' },
      {
        modelKey: 'gemini-3.1',
        modelId: 'google/gemini-3.1-flash-image',
        label: 'Image Generation',
      },
    ]);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
  });

  it('skips an agent-backed spec whose agent no longer exists', async () => {
    const sources = await getQuotaModelSources('tenant-a');
    expect(sources.some((source) => source.label === 'Ghost')).toBe(false);
  });

  it('returns nothing when the tenant has no model specs', async () => {
    mockGetAppConfig.mockResolvedValue({});
    await expect(getQuotaModelSources('tenant-a')).resolves.toEqual([]);
  });
});
