const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/services/usageQuota', () => ({
  getCalendarMonthRange: () => ({
    start: new Date('2026-10-01T00:00:00.000Z'),
    end: new Date('2026-11-01T00:00:00.000Z'),
    timezone: 'UTC',
  }),
  zonedDateTimeToUtc: ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)),
}));

const TENANT = 'tenant-requests';
const ADA = new mongoose.Types.ObjectId();
const BEN = new mongoose.Types.ObjectId();

function row({ user, messageId, context = 'message', tokenType = 'completion', day = '27' }) {
  return {
    user,
    tenantId: TENANT,
    conversationId: `convo-${String(user)}`,
    messageId,
    context,
    tokenType,
    model: 'openai/gpt-6-luna',
    providerModelId: 'openai/gpt-6-luna',
    providerKey: 'openrouter',
    rawAmount: -10,
    tokenValue: -20,
    createdAt: new Date(`2026-10-${day}T10:00:00.000Z`),
  };
}

/** Prompt and completion rows for one model call. */
const call = (args) => [row({ ...args, tokenType: 'prompt' }), row(args)];

/**
 * A request is one message a member sends. Its reply may take several model
 * calls (tool steps), each written as a prompt and a completion row, plus side
 * calls such as the chat title; none of that should multiply the count.
 */
describe('institutionUsage request counts', () => {
  let mongoServer;
  let usage;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    usage = require('./institutionUsage');

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Request Test', timezone: 'UTC' });
    await mongoose.connection.collection('transactions').insertMany([
      /** Ada, first message of a chat: a reply with two tool steps, plus its title. */
      ...call({ user: ADA, messageId: 'ada-1' }),
      ...call({ user: ADA, messageId: 'ada-1' }),
      ...call({ user: ADA, messageId: 'ada-1', context: 'title' }),
      /** Ada, follow-up: one model call and a summarization side call. */
      ...call({ user: ADA, messageId: 'ada-2' }),
      ...call({ user: ADA, messageId: 'ada-2', context: 'summarization' }),
      /** Ben stops a reply mid-stream; the spend is written as `abort`. */
      ...call({ user: BEN, messageId: 'ben-1', context: 'abort' }),
      /** Ben's message the day before. */
      ...call({ user: BEN, messageId: 'ben-0', day: '26' }),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const range = { tenantId: TENANT, start: '2026-10-01', end: '2026-10-31' };

  it('counts each member message once in the summary', async () => {
    const { summary } = await usage.getUsageSummary(range);
    expect(summary.eventCount).toBe(4);
    expect(summary.memberCount).toBe(2);
    expect(summary.totalTokens).toBe(14 * 10);
  });

  it('counts each member message once per member', async () => {
    const { members } = await usage.listUsageByMember({ ...range, limit: 10 });
    const byId = new Map(members.map((member) => [member.userId, member.eventCount]));
    expect(byId.get(String(ADA))).toBe(2);
    expect(byId.get(String(BEN))).toBe(2);
  });

  it('counts each member message once on the day it was sent', async () => {
    const { points } = await usage.getUsageTimeseries(range);
    expect(points.map(({ day, eventCount }) => [day, eventCount])).toEqual([
      ['2026-10-26', 1],
      ['2026-10-27', 3],
    ]);
  });

  it('counts each member message once in the member detail', async () => {
    const { summary } = await usage.getMemberUsageSummary({ ...range, userId: String(ADA) });
    expect(summary.eventCount).toBe(2);
  });
});
