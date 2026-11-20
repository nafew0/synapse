import type { BdrenAllowancePayload } from '@librechat/data-schemas';
import { bucketRanges, dhakaWindows, fallbackAllowance, resolveAllowance } from './windows';
import { readBdrenConfig } from './config';

const config = readBdrenConfig({
  BDREN_ALLOWANCE_ENABLED: 'true',
  BDREN_API_URL: 'https://bdren.test/',
  BDREN_PRODUCT_KEY: 'k',
  BDREN_ISSUER: 'https://auth.bdren.test',
});
const now = new Date('2026-11-20T10:00:00Z');

function payload(overrides: Partial<BdrenAllowancePayload> = {}): BdrenAllowancePayload {
  return {
    product: 'synapse',
    user: { subject: 's1' },
    plan_source: 'personal',
    package: { slug: 'pro', name: 'Pro', version: 1 },
    institution: null,
    subscription: {
      id: 'sub',
      status: 'active',
      starts_at: '2026-11-15T04:00:00Z',
      expires_at: '2026-12-15T04:00:00Z',
    },
    limits: { ai_credits: { monthly: 1000, weekly: 350 } },
    windows: {
      month: { start: '2026-11-15T04:00:00Z', end: '2026-12-15T04:00:00Z' },
      week: { start: '2026-11-15T04:00:00Z', end: '2026-11-22T04:00:00Z' },
    },
    etag: 'e',
    ...overrides,
  };
}

describe('dhakaWindows', () => {
  it('uses the Dhaka calendar: month on the 1st, week from Monday', () => {
    const { month, week } = dhakaWindows(now);
    expect(month.start.toISOString()).toBe('2026-10-31T18:00:00.000Z');
    expect(month.end.toISOString()).toBe('2026-11-30T18:00:00.000Z');
    expect(week.start.toISOString()).toBe('2026-11-15T18:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-11-22T18:00:00.000Z');
  });

  it('puts a late-evening UTC instant in the next Dhaka day', () => {
    const { month } = dhakaWindows(new Date('2026-11-30T19:00:00Z'));
    expect(month.start.toISOString()).toBe('2026-11-30T18:00:00.000Z');
  });
});

describe('resolveAllowance', () => {
  it('takes limits and windows from the subscription, not the calendar', () => {
    const resolved = resolveAllowance(payload(), config, now);
    expect(resolved?.member.month.limit).toBe(1000);
    expect(resolved?.member.week.limit).toBe(350);
    expect(resolved?.member.month.window.start.toISOString()).toBe('2026-11-15T04:00:00.000Z');
    expect(resolved?.institution).toBeNull();
  });

  it('sets a seat ceiling of seats × the seat level, for a seat only', () => {
    const seat = resolveAllowance(
      payload({ plan_source: 'institution', institution: { id: 'o', seats: 10 } }),
      config,
      now,
    );
    expect(seat?.institution?.month.limit).toBe(10_000);
    expect(seat?.institution?.week.limit).toBe(3500);
    const personal = resolveAllowance(
      payload({ institution: { id: 'o', seats: 10 } }),
      config,
      now,
    );
    expect(personal?.institution).toBeNull();
  });

  it('never reads a missing limit as unlimited', () => {
    expect(resolveAllowance(payload({ limits: {} }), config, now)).toBeNull();
    expect(resolveAllowance(payload({ limits: { ai_credits: {} } }), config, now)).toBeNull();
    expect(
      resolveAllowance(payload({ limits: { ai_credits: { daily: 5 } } }), config, now),
    ).toBeNull();
  });

  it('refuses a limit whose window is missing, ended or not yet started', () => {
    expect(resolveAllowance(payload({ windows: {} }), config, now)).toBeNull();
    const ended = { month: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } };
    expect(resolveAllowance(payload({ windows: ended }), config, now)).toBeNull();
    const future = { month: { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' } };
    expect(resolveAllowance(payload({ windows: future }), config, now)).toBeNull();
  });

  it('meters a one-time (lifetime) grant as the month slot with no end', () => {
    const resolved = resolveAllowance(
      payload({
        limits: { ai_credits: { lifetime: 500 } },
        windows: { lifetime: { start: '2026-11-01T00:00:00Z', end: null } },
      }),
      config,
      now,
    );
    expect(resolved?.member.month.limit).toBe(500);
    expect(resolved?.member.week.limit).toBeNull();
    expect(resolved?.member.month.window.end.getUTCFullYear()).toBe(9999);
  });
});

describe('fallbackAllowance', () => {
  it('is a finite Free allowance on the Dhaka calendar', () => {
    const free = fallbackAllowance(config, now);
    expect(free.origin).toBe('fallback');
    expect(free.planSource).toBe('free');
    expect(Number.isFinite(free.member.month.limit)).toBe(true);
    expect(free.member.month.limit).toBeGreaterThan(0);
    expect(free.member.week.window.start.toISOString()).toBe('2026-11-15T18:00:00.000Z');
  });
});

describe('readBdrenConfig', () => {
  it('stays off unless explicitly enabled with an address, key and issuer', () => {
    expect(readBdrenConfig({}).enabled).toBe(false);
    expect(
      readBdrenConfig({ BDREN_ALLOWANCE_ENABLED: 'true', BDREN_API_URL: 'https://x' }).enabled,
    ).toBe(false);
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('https://bdren.test');
  });

  it('reads several webhook secrets for rotation', () => {
    expect(readBdrenConfig({ BDREN_WEBHOOK_SECRET: ' a , b ,' }).webhookSecrets).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('bucketRanges', () => {
  it('keeps the first week of a subscription out of the month bucket', () => {
    const start = new Date('2026-11-20T04:00:00Z');
    const month = { start, end: new Date('2026-12-20T04:00:00Z') };
    const week = { start, end: new Date('2026-11-27T04:00:00Z') };
    const ranges = bucketRanges(month, week);
    expect(ranges.month.start.getTime()).not.toBe(ranges.week.start.getTime());
    expect(ranges.week.end).toEqual(week.end);
  });

  it('leaves windows that start apart untouched', () => {
    const month = {
      start: new Date('2026-11-01T00:00:00Z'),
      end: new Date('2026-12-01T00:00:00Z'),
    };
    const week = { start: new Date('2026-11-15T00:00:00Z'), end: new Date('2026-11-22T00:00:00Z') };
    expect(bucketRanges(month, week)).toEqual({ month, week });
  });
});
