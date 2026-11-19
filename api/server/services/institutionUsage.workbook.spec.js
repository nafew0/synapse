const XLSX = require('xlsx');
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

const labels = {
  restrictToLabeled: false,
  index: buildModelLabelIndex({
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
      ],
    },
  }),
};

const TENANT = 'tenant-alpha';
const ids = {
  heavy: new mongoose.Types.ObjectId(),
  light: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  idle: new mongoose.Types.ObjectId(),
  removed: new mongoose.Types.ObjectId(),
  outsider: new mongoose.Types.ObjectId(),
};

function spend({
  user,
  conversationId,
  model,
  amount,
  tenantId = TENANT,
  tokenType = 'completion',
}) {
  return {
    user,
    tenantId,
    conversationId,
    tokenType,
    model,
    providerModelId: model,
    providerKey: 'openrouter',
    rawAmount: -amount,
    tokenValue: -amount,
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
  };
}

/** Reads the workbook back the way Excel would see it: cell values, formulas, formats. */
function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true });
  return workbook.Sheets[workbook.SheetNames[0]];
}

describe('exportMemberUsageWorkbook', () => {
  let mongoServer;
  let exportMemberUsageWorkbook;
  let sheet;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    require('~/db/models');
    ({ exportMemberUsageWorkbook } = require('./institutionUsage'));
    const db = mongoose.connection;

    await db
      .collection('institutions')
      .insertOne({ tenantId: TENANT, name: 'Alpha University', timezone: 'UTC' });
    const user = (_id, name, extra = {}) => ({
      _id,
      tenantId: TENANT,
      name,
      email: `${name.split(' ')[0].toLowerCase()}@alpha.bd`,
      role: 'USER',
      membershipStatus: 'active',
      createdAt: new Date('2026-02-03T06:00:00.000Z'),
      ...extra,
    });
    await db
      .collection('users')
      .insertMany([
        user(ids.heavy, 'Heavy User'),
        user(ids.light, 'Light User'),
        user(ids.admin, 'Admin Person', { role: 'INSTITUTION_ADMIN' }),
        user(ids.idle, 'Idle Member'),
        user(ids.removed, 'Removed Member', { membershipStatus: 'removed' }),
        user(ids.outsider, 'Other Tenant', { tenantId: 'tenant-beta' }),
      ]);
    await db.collection('conversations').insertMany([
      { conversationId: 'c-chat', tenantId: TENANT, spec: 'gpt-6-luna' },
      { conversationId: 'c-old-chat', tenantId: TENANT, spec: 'gpt-5.6-luna' },
      { conversationId: 'c-claude', tenantId: TENANT, spec: 'anthropic/claude-haiku-5.5' },
      { conversationId: 'c-glm', tenantId: TENANT, spec: 'z-ai-glm-5-2' },
    ]);
    await db.collection('transactions').insertMany([
      spend({
        user: ids.heavy,
        conversationId: 'c-chat',
        model: 'openai/gpt-6-luna',
        amount: 200_000,
      }),
      spend({
        user: ids.heavy,
        conversationId: 'c-chat',
        model: 'openai/gpt-6-luna',
        amount: 50_000,
        tokenType: 'prompt',
      }),
      spend({
        user: ids.heavy,
        conversationId: 'c-old-chat',
        model: 'openai/gpt-5.6-luna',
        amount: 30_000,
      }),
      spend({
        user: ids.heavy,
        conversationId: 'c-claude',
        model: 'anthropic/claude-haiku-5.5',
        amount: 40_000,
      }),
      spend({
        user: ids.light,
        conversationId: 'c-claude',
        model: 'anthropic/claude-haiku-5.5',
        amount: 2_500,
      }),
      spend({ user: ids.admin, conversationId: 'c-glm', model: 'z-ai/glm-5.2', amount: 700 }),
      spend({
        user: ids.outsider,
        conversationId: 'c-x',
        model: 'openai/gpt-6-luna',
        amount: 9_999,
        tenantId: 'tenant-beta',
      }),
      spend({
        user: ids.removed,
        conversationId: 'c-gone',
        model: 'google/gemini-3.8-flash',
        amount: 5_000,
      }),
    ]);

    const { buffer } = await exportMemberUsageWorkbook({
      tenantId: TENANT,
      start: '2026-09-01',
      end: '2026-09-30',
      labels,
      now: new Date('2026-10-27T09:30:00.000Z'),
    });
    sheet = readSheet(buffer);
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const value = (address) => sheet[address]?.v;
  const row = (r, lastCol = 'I') =>
    XLSX.utils.sheet_to_json(sheet, { header: 1, range: `A${r}:${lastCol}${r}`, raw: true })[0] ??
    [];

  it('opens with a summary of the institution and period', () => {
    expect(value('A1')).toBe('Member usage report');
    expect([value('A2'), value('B2')]).toEqual(['Institution', 'Alpha University']);
    expect(value('B3')).toBe('2026-09-01 to 2026-09-30 (UTC)');
    expect(value('A5')).toBe('Active members');
    expect(value('B7')).toBe('2026-10-27 09:30');
  });

  it('computes the summary with formulas over the member rows', () => {
    expect(sheet.B4).toMatchObject({ f: 'COUNTA(C10:C13)', v: 4 });
    expect(sheet.B5).toMatchObject({ f: 'COUNTIF(I10:I13,">0")', v: 3 });
    expect(sheet.B6).toMatchObject({ f: 'SUM(I10:I13)', v: 323_200 });
  });

  it('gives each model its own column, retired models last, then the total', () => {
    expect(row(9)).toEqual([
      'User ID',
      'Account created at',
      'Name',
      'Email',
      'Role',
      'ChatGPT',
      'Claude',
      'Other (retired models)',
      'Total Used Tokens',
    ]);
  });

  it('lists every member who can sign in, busiest first, idle ones with zeros', () => {
    expect(row(10)).toEqual([
      String(ids.heavy),
      '2026-02-03 06:00',
      'Heavy User',
      'heavy@alpha.bd',
      'Member',
      280_000,
      40_000,
      0,
      320_000,
    ]);
    expect(row(11).slice(2, 9)).toEqual([
      'Light User',
      'light@alpha.bd',
      'Member',
      0,
      2_500,
      0,
      2_500,
    ]);
    expect(row(12).slice(2, 9)).toEqual([
      'Admin Person',
      'admin@alpha.bd',
      'Institution admin',
      0,
      0,
      700,
      700,
    ]);
    expect(row(13).slice(2, 9)).toEqual(['Idle Member', 'idle@alpha.bd', 'Member', 0, 0, 0, 0]);
    const names = [10, 11, 12, 13, 14].map((r) => value(`C${r}`));
    expect(names).not.toContain('Removed Member');
    expect(names).not.toContain('Other Tenant');
  });

  it('leaves out usage by removed members and other institutions, even as a column', () => {
    expect(row(9)).not.toContain('Google Gemini (Latest)');
    expect(sheet.I14.v).toBe(323_200);
  });

  it('totals each row and each column with formulas and shows tokens as K/M', () => {
    expect(sheet.I10).toMatchObject({ f: 'SUM(F10:H10)', v: 320_000 });
    expect(sheet.F10.z).toBe('[>=99950]0.0#,,"M";[>=1000]0.0,"K";0');
    expect(value('A14')).toBe('Total');
    expect(sheet.F14).toMatchObject({ f: 'SUM(F10:F13)', v: 280_000 });
    expect(sheet.I14).toMatchObject({ f: 'SUM(I10:I13)', v: 323_200 });
  });
});
