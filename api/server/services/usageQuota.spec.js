jest.mock('@librechat/data-schemas', () => ({
  getTransactionSupport: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  runAsSystem: (fn) => fn(),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    matchModelName: (model) => {
      if (String(model).includes('gpt-4o')) return 'gpt-4o';
      return undefined;
    },
    isEnforcementDenial: actual.isEnforcementDenial,
    toBillingTokens: actual.toBillingTokens,
    unitFor: actual.unitFor,
    weightFor: actual.weightFor,
    /** Built at module load; only the credit path reads from it. */
    createUsageCatalog: actual.createUsageCatalog,
  };
});

jest.mock('~/db/models', () => ({
  Institution: {},
  UsagePolicy: {},
  UsageBucket: {},
  UsageReservation: {},
}));

const {
  QuotaError,
  canonicalizeModel,
  getCalendarMonthRange,
  getCalendarWeekRange,
  getPolicyRanges,
  isEnforcementDenial,
} = require('./usageQuota');

describe('usageQuota calendar and canonicalization', () => {
  it('stores an Asia/Dhaka calendar month as UTC boundaries', () => {
    const range = getCalendarMonthRange('Asia/Dhaka', new Date('2026-07-15T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-06-30T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-31T18:00:00.000Z');
  });

  it('uses the correct DST offsets on both sides of a New York month', () => {
    const march = getCalendarMonthRange('America/New_York', new Date('2026-03-15T12:00:00.000Z'));
    expect(march.start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(march.end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('canonicalizes provider-prefixed aliases to one model key', () => {
    expect(canonicalizeModel({ provider: 'OpenAI', model: 'openai/gpt-4o-2024-08-06' })).toEqual({
      providerKey: 'openai',
      providerModelId: 'gpt-4o-2024-08-06',
      modelKey: 'gpt-4o',
    });
  });

  it('returns the quota response body contract', () => {
    const error = new QuotaError({
      scope: 'member',
      limit: 100,
      used: 90,
      reserved: 10,
      remaining: 0,
      resetAt: '2026-08-01T00:00:00.000Z',
    });
    expect(error.statusCode).toBe(429);
    expect(error.body).toEqual({
      error: expect.objectContaining({
        code: 'TOKEN_QUOTA_EXCEEDED',
        scope: 'member',
        remaining: 0,
      }),
    });
  });
});

describe('isEnforcementDenial', () => {
  it('treats a capacity denial as a refusal the caller must surface', () => {
    expect(isEnforcementDenial(new QuotaError({ scope: 'member', limit: 10 }))).toBe(true);
  });

  it('treats a misconfigured enforce topology as a refusal', () => {
    const error = new QuotaError({ code: 'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS' });
    expect(isEnforcementDenial(error)).toBe(true);
  });

  it('treats missing institution or policy records as availability faults, not refusals', () => {
    expect(isEnforcementDenial(new QuotaError({ code: 'INSTITUTION_NOT_FOUND' }))).toBe(false);
    expect(isEnforcementDenial(new QuotaError({ code: 'USAGE_POLICY_NOT_FOUND' }))).toBe(false);
    expect(isEnforcementDenial(new QuotaError({ code: 'INVALID_INSTITUTION_TIMEZONE' }))).toBe(
      false,
    );
    expect(isEnforcementDenial(new QuotaError({ code: 'INVALID_QUOTA_CONTEXT' }))).toBe(false);
  });

  it('never treats an unrelated database error as a refusal', () => {
    expect(isEnforcementDenial(new Error('connection reset'))).toBe(false);
    expect(isEnforcementDenial(undefined)).toBe(false);
  });
});

describe('usageQuota calendar weeks', () => {
  /** 2026-07-15 is a Wednesday; the ISO week it belongs to starts Monday 13 July. */
  it('anchors the week to Monday 00:00 in the institution timezone', () => {
    const range = getCalendarWeekRange('Asia/Dhaka', new Date('2026-07-15T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-07-12T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-19T18:00:00.000Z');
  });

  it('keeps a Monday in its own week rather than the previous one', () => {
    const range = getCalendarWeekRange('Asia/Dhaka', new Date('2026-07-13T06:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-07-12T18:00:00.000Z');
  });

  it('rolls a Sunday into the week that is about to end', () => {
    const range = getCalendarWeekRange('Asia/Dhaka', new Date('2026-07-19T06:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-07-12T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-19T18:00:00.000Z');
  });

  /** US DST begins Sunday 2026-03-08, inside the Mon 2 -> Mon 9 week. Both
   *  boundaries stay LOCAL midnight — 05:00Z under EST, 04:00Z under EDT — so the
   *  week is 167 hours, not 168. Adding 7x24h to the start would have put the
   *  reset an hour late and overlapped the following week. */
  it('holds both Monday boundaries across a DST transition inside the week', () => {
    const range = getCalendarWeekRange('America/New_York', new Date('2026-03-04T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-03-02T05:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(range.end.getTime() - range.start.getTime()).toBe(167 * 60 * 60 * 1000);
  });

  it('hands the next week the boundary the DST week ended on', () => {
    const dstWeek = getCalendarWeekRange('America/New_York', new Date('2026-03-04T12:00:00.000Z'));
    const nextWeek = getCalendarWeekRange('America/New_York', new Date('2026-03-11T12:00:00.000Z'));
    expect(nextWeek.start.getTime()).toBe(dstWeek.end.getTime());
    expect(nextWeek.end.getTime() - nextWeek.start.getTime()).toBe(168 * 60 * 60 * 1000);
  });

  it('a later week never overlaps the one before it', () => {
    const first = getCalendarWeekRange('Asia/Dhaka', new Date('2026-07-15T12:00:00.000Z'));
    const next = getCalendarWeekRange('Asia/Dhaka', new Date('2026-07-22T12:00:00.000Z'));
    expect(next.start.getTime()).toBe(first.end.getTime());
  });
});

describe('getPolicyRanges', () => {
  const policy = (period) => ({ timezone: 'Asia/Dhaka', period });

  it('returns a week range only when the policy enforces one', () => {
    expect(getPolicyRanges(policy(['calendar_month'])).week).toBeNull();
    expect(getPolicyRanges(policy(['calendar_month', 'calendar_week'])).week).not.toBeNull();
  });

  it('tolerates a legacy scalar period', () => {
    const ranges = getPolicyRanges(policy('calendar_month'));
    expect(ranges.month.start).toBeInstanceOf(Date);
    expect(ranges.week).toBeNull();
  });
});
