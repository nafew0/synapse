const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/services/usageQuota', () => ({
  getCalendarMonthRange: () => ({
    start: new Date('2026-11-01T00:00:00.000Z'),
    end: new Date('2026-12-01T00:00:00.000Z'),
    timezone: 'UTC',
  }),
  zonedDateTimeToUtc: ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)),
}));

const TENANT = 'tenant-services';
const OTHER = 'tenant-other';
const ADA = new mongoose.Types.ObjectId();
const createdAt = new Date('2026-11-10T10:00:00.000Z');

const modelRow = (tokenType, tokenValue) => ({
  user: ADA,
  tenantId: TENANT,
  messageId: 'm-1',
  context: 'message',
  tokenType,
  model: 'openai/gpt-6-luna',
  providerKey: 'openrouter',
  service: 'openrouter',
  rawAmount: -10,
  tokenValue,
  createdAt,
});

const serviceRow = (service, usageKind, credits, extra = {}) => ({
  user: ADA,
  tenantId: TENANT,
  tokenType: 'credits',
  service,
  usageKind,
  context: usageKind,
  tokenValue: -credits,
  costUsd: credits / 1e6,
  createdAt,
  ...extra,
});

describe('institutionUsage totals with paid services', () => {
  let mongoServer;
  let usage;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    usage = require('./institutionUsage');

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Services Test', timezone: 'UTC' });
    await mongoose.connection.collection('transactions').insertMany([
      modelRow('prompt', -1000),
      modelRow('completion', -2000),
      serviceRow('firecrawl', 'web_search', 7600),
      serviceRow('stt', 'voice', 833, { billable: true }),
      serviceRow('embeddings', 'embedding_index', 9000, { billable: false }),
      serviceRow('unstructured', 'ocr', 45000, { pages: 3 }),
      /** Written before `service` existed: only `usageKind` says it is OCR. */
      serviceRow(undefined, 'ocr', 15000, { pages: 1 }),
      /** A balance top-up is a credits row too, but not a service charge. */
      {
        user: ADA,
        tenantId: TENANT,
        tokenType: 'credits',
        context: 'autoRefill',
        tokenValue: 50000,
        createdAt,
      },
      { ...serviceRow('firecrawl', 'web_scrape', 99000), tenantId: OTHER },
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('adds every service to totalCost and lists each one', async () => {
    const { summary } = await usage.getUsageSummary({
      tenantId: TENANT,
      start: '2026-11-01',
      end: '2026-11-30',
    });

    expect(summary.serviceCost).toEqual({
      firecrawl: 7600,
      stt: 833,
      embeddings: 9000,
      unstructured: 60000,
    });
    expect(summary.totalCost).toBe(3000 + 7600 + 833 + 9000 + 60000);
    expect(summary.ocrPages).toBe(4);
    expect(summary.totalTokens).toBe(20);
  });

  it('hides cost figures from label-restricted viewers', async () => {
    const { summary } = await usage.getUsageSummary({
      tenantId: TENANT,
      start: '2026-11-01',
      end: '2026-11-30',
      labels: { restrictToLabeled: true },
    });
    expect(summary.totalCost).toBeUndefined();
    expect(summary.serviceCost).toBeUndefined();
  });
});
