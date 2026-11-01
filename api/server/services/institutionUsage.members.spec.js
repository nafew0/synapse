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

const TENANT = 'tenant-members';
const OTHER_TENANT = 'tenant-elsewhere';
const id = () => new mongoose.Types.ObjectId();
const ADA = id();
const BEN = id();
const CAL = id();
const DEB = id();
const EVE = id();
const GONE = id();
const OUTSIDER = id();

function user(_id, name, extra = {}) {
  return {
    _id,
    name,
    email: `${name.toLowerCase()}@example.test`,
    username: name.toLowerCase(),
    role: 'USER',
    tenantId: TENANT,
    membershipStatus: 'active',
    ...extra,
  };
}

function spend(userId, tokens) {
  return ['prompt', 'completion'].map((tokenType) => ({
    user: userId,
    tenantId: TENANT,
    conversationId: `convo-${String(userId)}`,
    messageId: `msg-${String(userId)}`,
    context: 'message',
    tokenType,
    model: 'openai/gpt-6-luna',
    providerModelId: 'openai/gpt-6-luna',
    providerKey: 'openrouter',
    rawAmount: -tokens / 2,
    tokenValue: -1,
    createdAt: new Date('2026-10-27T10:00:00.000Z'),
  }));
}

/**
 * The member ranking lists everyone in the institution, not only those who
 * used tokens: idle members appear with zero usage at the bottom.
 */
describe('institutionUsage member ranking', () => {
  let mongoServer;
  let usage;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    usage = require('./institutionUsage');

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Members Test', timezone: 'UTC' });
    await mongoose.connection
      .collection('users')
      .insertMany([
        user(ADA, 'Ada'),
        user(BEN, 'Ben'),
        user(CAL, 'Cal'),
        user(DEB, 'Deb', { membershipStatus: 'suspended' }),
        user(EVE, 'Eve', { membershipStatus: 'removed' }),
        user(OUTSIDER, 'Outsider', { tenantId: OTHER_TENANT }),
      ]);
    await mongoose.connection
      .collection('transactions')
      .insertMany([...spend(BEN, 300), ...spend(ADA, 100), ...spend(GONE, 50)]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const range = { tenantId: TENANT, start: '2026-10-01', end: '2026-10-31' };
  const names = (members) => members.map((member) => member.name);

  it('lists every member busiest first, with idle members at zero', async () => {
    const { members, total } = await usage.listUsageByMember({ ...range, limit: 10 });

    expect(total).toBe(5);
    expect(names(members)).toEqual(['Ben', 'Ada', 'Unknown member', 'Cal', 'Deb']);
    expect(members.map((member) => member.totalTokens)).toEqual([300, 100, 50, 0, 0]);
    expect(members[3]).toMatchObject({ eventCount: 0, email: 'cal@example.test', role: 'USER' });
    expect(members[3]).not.toHaveProperty('username');
  });

  it('leaves out removed members and other institutions', async () => {
    const { members } = await usage.listUsageByMember({ ...range, limit: 10 });

    expect(names(members)).not.toContain('Eve');
    expect(names(members)).not.toContain('Outsider');
  });

  it('pages through the ranking', async () => {
    const first = await usage.listUsageByMember({ ...range, limit: 2, offset: 0 });
    const last = await usage.listUsageByMember({ ...range, limit: 2, offset: 4 });

    expect(names(first.members)).toEqual(['Ben', 'Ada']);
    expect(names(last.members)).toEqual(['Deb']);
    expect(last.total).toBe(5);
  });

  it('searches idle members too', async () => {
    const { members, total } = await usage.listUsageByMember({ ...range, query: 'cal@' });

    expect(total).toBe(1);
    expect(names(members)).toEqual(['Cal']);
  });

  it('hides cost from a labeled view', async () => {
    const { members } = await usage.listUsageByMember({
      ...range,
      labels: { restrictToLabeled: true },
    });

    expect(members.every((member) => !('totalCost' in member))).toBe(true);
  });
});
