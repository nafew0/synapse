import { aggregate, compare, eachDay, firecrawlDayCredits, monthOf, weekStart } from './maths';

describe('compare', () => {
  it('is ok inside the 3% threshold, either way', () => {
    expect(compare(10.2, 10).status).toBe('ok');
    expect(compare(9.8, 10).status).toBe('ok');
    expect(compare(10.3, 10)).toMatchObject({ status: 'ok', gap: expect.closeTo(0.3, 6) });
  });

  it('flags a gap above 3%, over and under', () => {
    expect(compare(10.4, 10)).toMatchObject({ status: 'flagged', gapPct: expect.closeTo(0.04, 6) });
    expect(compare(9.6, 10)).toMatchObject({ status: 'flagged', gapPct: expect.closeTo(-0.04, 6) });
  });

  it('treats exactly 3% as within the limit', () => {
    expect(compare(103, 100).status).toBe('ok');
  });

  it('reports missing provider data instead of a gap', () => {
    expect(compare(5, null)).toEqual({
      ledger: 5,
      provider: null,
      gap: null,
      gapPct: null,
      status: 'missing_provider',
    });
    expect(compare(0, null).status).toBe('empty');
  });

  it('reports spend the ledger never recorded', () => {
    expect(compare(0, 4)).toMatchObject({ status: 'missing_ledger', gap: -4, gapPct: -1 });
  });

  it('flags recorded spend the provider did not charge', () => {
    expect(compare(3, 0)).toMatchObject({ status: 'flagged', gapPct: null });
  });

  it('ignores rounding noise below the floor', () => {
    expect(compare(0.004, 0).status).toBe('ok');
    expect(compare(0.2, 0.0, 0.03, 0.5).status).toBe('ok');
  });

  it('honours another threshold', () => {
    expect(compare(10.4, 10, 0.05).status).toBe('ok');
  });
});

describe('weeks and months', () => {
  it('starts weeks on Monday', () => {
    expect(weekStart('2026-11-20')).toBe('2026-11-16');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(weekStart('2026-11-22')).toBe('2026-11-16');
    expect(weekStart('2026-11-23')).toBe('2026-11-23');
  });

  it('lists days and months', () => {
    expect(eachDay('2026-11-29', '2026-12-02')).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
    expect(monthOf('2026-11-29')).toBe('2026-11');
  });
});

describe('aggregate', () => {
  const week = (rows: Array<[string, number, number | null]>) =>
    rows.map(([day, ledger, provider]) => ({ day, ledger, provider }));

  it('sums a full week and compares the totals', () => {
    const rows = week([
      ['2026-11-16', 10, 10.1],
      ['2026-11-17', 10, 9.9],
      ['2026-11-18', 10, 10],
      ['2026-11-19', 10, 10.2],
      ['2026-11-20', 10, 10],
      ['2026-11-21', 10, 9.8],
      ['2026-11-22', 10, 10],
    ]);
    const [row] = aggregate(rows, weekStart);
    expect(row).toMatchObject({ period: '2026-11-16', days: 7, daysCovered: 7, status: 'ok' });
    expect(row.ledger).toBe(70);
    expect(row.provider).toBeCloseTo(70, 6);
  });

  it('flags a week whose total is more than 3% off even when single days are close', () => {
    const rows = week([
      ['2026-11-16', 10, 9.5],
      ['2026-11-17', 10, 9.5],
      ['2026-11-18', 10, 9.5],
    ]);
    expect(aggregate(rows, weekStart)[0].status).toBe('flagged');
  });

  it('compares only the days that have provider data and says how many', () => {
    const rows = week([
      ['2026-11-16', 10, 10],
      ['2026-11-17', 10, null],
      ['2026-11-18', 10, 10],
    ]);
    const [row] = aggregate(rows, weekStart);
    expect(row).toMatchObject({
      days: 3,
      daysCovered: 2,
      ledger: 20,
      provider: 10 + 10,
      ledgerAll: 30,
    });
    expect(row.status).toBe('ok');
  });

  it('marks a week with no provider data as missing', () => {
    const rows = week([
      ['2026-11-16', 4, null],
      ['2026-11-17', 6, null],
    ]);
    const [row] = aggregate(rows, weekStart);
    expect(row).toMatchObject({ status: 'missing_provider', daysCovered: 0, ledger: 10 });
  });

  it('splits periods at the week boundary', () => {
    const rows = week([
      ['2026-11-22', 1, 1],
      ['2026-11-23', 2, 2],
    ]);
    expect(aggregate(rows, weekStart).map((row) => row.period)).toEqual([
      '2026-11-16',
      '2026-11-23',
    ]);
  });
});

describe('firecrawlDayCredits', () => {
  const reading = (cumulative: number, periodStart: string | null = '2026-11-07') => ({
    cumulative,
    periodStart,
  });

  it('is the change in the period counter', () => {
    expect(firecrawlDayCredits(reading(100), reading(112))).toBe(12);
  });

  it('starts from zero in a new billing period', () => {
    expect(firecrawlDayCredits(reading(900), reading(7, '2026-12-07'))).toBe(7);
  });

  it('does not guess without yesterday or when the counter went backwards', () => {
    expect(firecrawlDayCredits(null, reading(112))).toBeNull();
    expect(firecrawlDayCredits(reading(120), reading(112))).toBeNull();
  });
});
