import type { Comparison, DayFigure, PeriodRow } from './types';

export const DEFAULT_THRESHOLD = 0.03;
const DAY_MS = 86_400_000;
/** Absorbs float error, so a gap of exactly the threshold (10.3 against 10) stays within it. */
const EPSILON = 1e-9;

/**
 * Compares one ledger figure with the provider's. Below `floor` (rounding noise, in the figure's own
 * unit) a difference is ignored. A missing provider figure is not a zero: it is reported as missing.
 */
export function compare(
  ledger: number,
  provider: number | null,
  threshold: number = DEFAULT_THRESHOLD,
  floor = 0.01,
): Comparison {
  if (provider === null) {
    return {
      ledger,
      provider,
      gap: null,
      gapPct: null,
      status: ledger > floor ? 'missing_provider' : 'empty',
    };
  }
  const gap = ledger - provider;
  const gapPct = provider > 0 ? gap / provider : null;
  if (Math.abs(gap) <= floor) return { ledger, provider, gap, gapPct, status: 'ok' };
  if (ledger <= floor) return { ledger, provider, gap, gapPct, status: 'missing_ledger' };
  const within = gapPct !== null && Math.abs(gapPct) <= threshold + EPSILON;
  return { ledger, provider, gap, gapPct, status: within ? 'ok' : 'flagged' };
}

/** Monday of the week a `YYYY-MM-DD` day falls in. Days are treated as plain calendar dates. */
export function weekStart(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(at.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export const monthOf = (day: string): string => day.slice(0, 7);

/**
 * Sums day figures into periods. Only days with provider data are compared, so a week with two missing
 * days is judged on the five it has (`daysCovered` says so) instead of failing for the whole week.
 */
export function aggregate(
  figures: DayFigure[],
  periodOf: (day: string) => string,
  threshold: number = DEFAULT_THRESHOLD,
  floor = 0.01,
): PeriodRow[] {
  const groups = new Map<string, DayFigure[]>();
  for (const figure of figures) {
    const key = periodOf(figure.day);
    groups.set(key, [...(groups.get(key) ?? []), figure]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, days]) => {
      const covered = days.filter((day) => day.provider !== null);
      const ledger = covered.reduce((sum, day) => sum + day.ledger, 0);
      const provider = covered.length
        ? covered.reduce((sum, day) => sum + (day.provider ?? 0), 0)
        : null;
      return {
        period,
        days: days.length,
        daysCovered: covered.length,
        ledgerAll: days.reduce((sum, day) => sum + day.ledger, 0),
        ...compare(
          covered.length ? ledger : days.reduce((sum, day) => sum + day.ledger, 0),
          provider,
          threshold,
          floor,
        ),
      };
    });
}

/** Every `YYYY-MM-DD` day from `start` to `end`, inclusive. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let at = new Date(`${start}T00:00:00Z`).getTime();
    at <= new Date(`${end}T00:00:00Z`).getTime();
    at += DAY_MS
  ) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

export interface FirecrawlReading {
  cumulative: number;
  periodStart: string | null;
}

/**
 * Credits used on a day from two end-of-day readings of the period counter. The first day of a new billing
 * period starts from zero. Without yesterday's reading, or when the counter went backwards, the day is
 * unknown (`null`) rather than a guess.
 */
export function firecrawlDayCredits(
  previous: FirecrawlReading | null,
  current: FirecrawlReading,
): number | null {
  if (!previous) return null;
  if (previous.periodStart !== current.periodStart) return current.cumulative;
  const used = current.cumulative - previous.cumulative;
  return used >= 0 ? used : null;
}
