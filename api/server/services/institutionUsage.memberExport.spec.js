const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('~/server/services/usageQuota', () => ({
  getCalendarMonthRange: () => ({
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-10-01T00:00:00.000Z'),
    timezone: 'Asia/Dhaka',
  }),
  zonedDateTimeToUtc: ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)),
}));

const TENANT = 'tenant-a';
const ADMIN = new mongoose.Types.ObjectId();
const HEAVY = new mongoose.Types.ObjectId();
const IDLE = new mongoose.Types.ObjectId();
const SUSPENDED = new mongoose.Types.ObjectId();
const REMOVED = new mongoose.Types.ObjectId();
const OUTSIDER = new mongoose.Types.ObjectId();
const BIG = new mongoose.Types.ObjectId();
const MID = new mongoose.Types.ObjectId();
const EDGE = new mongoose.Types.ObjectId();

function user(_id, fields) {
  return {
    _id,
    tenantId: TENANT,
    accountScope: 'institution',
    provider: 'local',
    role: 'USER',
    membershipStatus: 'active',
    createdAt: new Date('2026-02-12T08:30:00.000Z'),
    ...fields,
  };
}

function usage(
  userId,
  amount,
  { tokenType = 'completion', at = '2026-09-15T10:00:00.000Z', tenantId = TENANT } = {},
) {
  return {
    user: userId,
    tenantId,
    conversationId: `convo-${String(userId)}`,
    tokenType,
    model: 'claude-haiku-4-5',
    providerKey: 'anthropic',
    rawAmount: -amount,
    tokenValue: -amount * 2,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  };
}

/** Minimal RFC 4180 reader: quoted cells may hold commas and doubled quotes. */
function parse(csv) {
  return csv
    .trim()
    .split('\n')
    .map((line) =>
      Array.from(line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g), (m) => m[1]).slice(0, -1),
    )
    .map((cells) =>
      cells.map((cell) => (cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell)),
    );
}

describe('exportMemberUsageCsv', () => {
  let mongoServer;
  let exportMemberUsageCsv;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    ({ exportMemberUsageCsv } = require('./institutionUsage'));

    await mongoose.connection
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Test Institution', timezone: 'Asia/Dhaka' });

    await mongoose.connection.collection('users').insertMany([
      user(ADMIN, { name: 'Ada Admin', email: 'ada@a.edu', role: 'INSTITUTION_ADMIN' }),
      user(HEAVY, { name: '=HYPERLINK("http://x","Bob")', email: 'bob@a.edu' }),
      user(IDLE, { name: 'Cara Idle', email: 'cara@a.edu' }),
      user(BIG, { name: 'Faria Big', email: 'faria@a.edu' }),
      user(MID, { name: 'Gias Mid', email: 'gias@a.edu' }),
      user(EDGE, { name: 'Hasan Edge', email: 'hasan@a.edu' }),
      user(SUSPENDED, {
        name: 'Dan Suspended',
        email: 'dan@a.edu',
        membershipStatus: 'suspended',
      }),
      user(REMOVED, { name: 'Eve Removed', email: 'eve@a.edu', membershipStatus: 'removed' }),
      user(OUTSIDER, { name: 'Other Tenant', email: 'o@b.edu', tenantId: 'tenant-b' }),
    ]);

    await mongoose.connection
      .collection('transactions')
      .insertMany([
        usage(HEAVY, 400, { tokenType: 'prompt' }),
        usage(HEAVY, 600),
        usage(ADMIN, 250),
        usage(SUSPENDED, 50),
        usage(BIG, 1_250_000),
        usage(MID, 412_380),
        usage(EDGE, 999_990),
        usage(HEAVY, 9999, { at: '2026-08-20T10:00:00.000Z' }),
        usage(OUTSIDER, 777, { tenantId: 'tenant-b' }),
      ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('writes one row per member with only the requested columns', async () => {
    const { csv } = await exportMemberUsageCsv({ tenantId: TENANT });
    const [header, ...rows] = parse(csv);

    expect(header).toEqual(['User ID', 'Account created at', 'Name', 'Role', 'Total Used Tokens']);
    expect(rows.map((row) => row[0])).toEqual([
      String(BIG),
      String(EDGE),
      String(MID),
      String(HEAVY),
      String(ADMIN),
      String(SUSPENDED),
      String(IDLE),
    ]);
  });

  it('totals tokens in the range as M above a million, K above a thousand', async () => {
    const { csv } = await exportMemberUsageCsv({ tenantId: TENANT });
    const totals = Object.fromEntries(
      parse(csv)
        .slice(1)
        .map((row) => [row[0], row[4]]),
    );

    expect(totals[String(BIG)]).toBe('1.25M');
    expect(totals[String(EDGE)]).toBe('1M');
    expect(totals[String(MID)]).toBe('412.4K');
    expect(totals[String(HEAVY)]).toBe('1K');
    expect(totals[String(ADMIN)]).toBe('250');
    expect(totals[String(IDLE)]).toBe('0');
  });

  it('labels roles and shows account creation in the institution timezone', async () => {
    const { csv } = await exportMemberUsageCsv({ tenantId: TENANT });
    const admin = parse(csv).find((row) => row[0] === String(ADMIN));

    expect(admin[1]).toBe('2026-02-12 14:30');
    expect(admin[2]).toBe('Ada Admin');
    expect(admin[3]).toBe('Institution admin');
  });

  it('leaves out removed members and other tenants', async () => {
    const { csv } = await exportMemberUsageCsv({ tenantId: TENANT });

    expect(csv).not.toContain(String(REMOVED));
    expect(csv).not.toContain(String(OUTSIDER));
  });

  it('defuses names that a spreadsheet would run as a formula', async () => {
    const { csv } = await exportMemberUsageCsv({ tenantId: TENANT });

    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""Bob"")"`);
  });
});
