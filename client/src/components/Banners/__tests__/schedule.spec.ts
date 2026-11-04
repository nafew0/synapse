import type { TBanner } from 'librechat-data-provider';
import { getCategoryStyle } from '../styles';
import { getSchedule } from '../schedule';

const banner = (overrides: Partial<TBanner>): TBanner => ({
  bannerId: 'b1',
  app: 'chat',
  type: 'banner',
  message: 'Hello',
  category: 'feature',
  display: 'once',
  displayFrom: '2026-11-04T08:10:00.000Z',
  displayTo: null,
  createdAt: '2026-11-04T08:00:00.000Z',
  updatedAt: '2026-11-04T08:00:00.000Z',
  isPublic: true,
  persistable: false,
  ...overrides,
});

const schedule = (overrides: Partial<TBanner>, now: Date) => {
  const b = banner(overrides);
  return getSchedule(b, getCategoryStyle(b.category), 'en-GB', now);
};

describe('getSchedule', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');

  it('gives news its start day and no time window', () => {
    expect(schedule({ category: 'update' }, now)).toEqual({ day: '4 Nov' });
  });

  it('shows only the time when maintenance ends today', () => {
    const end = new Date(now);
    end.setHours(23, 0, 0, 0);
    const { window } = schedule({ category: 'maintenance', displayTo: end.toISOString() }, now);
    expect(window?.kind).toBe('until');
    expect(window?.moment).toBe(
      end.toLocaleString('en-GB', { hour: 'numeric', minute: '2-digit' }),
    );
  });

  it('adds the date when maintenance ends on another day', () => {
    const { window } = schedule(
      { category: 'maintenance', displayTo: '2026-11-09T12:00:00.000Z' },
      now,
    );
    expect(window?.moment).toContain('Nov');
  });

  it('counts an outage from its start', () => {
    expect(schedule({ category: 'outage' }, now).window?.kind).toBe('since');
  });

  it('falls back to the browser locale when the stored language tag is malformed', () => {
    const b = banner({});
    expect(() => getSchedule(b, getCategoryStyle('feature'), 'not a locale', now)).not.toThrow();
  });
});
