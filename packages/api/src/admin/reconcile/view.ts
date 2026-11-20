import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import type {
  DayFigure,
  PeriodRow,
  Comparison,
  SyncState,
  ReconcileUnit,
  ReconcileService,
  ProviderSpendRecord,
} from './types';
import type { Range } from '~/usage/spend';
import { aggregate, compare, DEFAULT_THRESHOLD, eachDay, monthOf, weekStart } from './maths';
import { dayStart, dhakaDay, nextDay, serviceOf } from '~/usage/rollup';
import { loadSpend, loadStates } from './store';

const CREDITS_PER_USD = 1_000_000;

interface ServiceSpec {
  service: ReconcileService;
  label: string;
  unit: ReconcileUnit;
  /** Ledger services that make up this provider's bill (voice is on the OpenRouter bill). */
  ledger: string[];
  /** Day boundaries the provider reports in. */
  timeZone: 'UTC' | 'Asia/Dhaka';
  floor: number;
  envKey: string;
}

const SPECS: ServiceSpec[] = [
  {
    service: 'openrouter',
    label: 'OpenRouter',
    unit: 'usd',
    ledger: ['openrouter', 'stt'],
    timeZone: 'UTC',
    floor: 0.01,
    envKey: 'OPENROUTER_MANAGEMENT_KEY',
  },
  {
    service: 'firecrawl',
    label: 'Firecrawl',
    unit: 'credits',
    ledger: ['firecrawl'],
    timeZone: 'Asia/Dhaka',
    floor: 0.5,
    envKey: 'FIRECRAWL_API_KEY',
  },
];

interface LedgerDay {
  usd: number;
  units: number;
}

/** Ledger totals per calendar day in the provider's own timezone, from the same rows the rollup reads. */
export async function loadLedger(
  services: string[],
  timeZone: 'UTC' | 'Asia/Dhaka',
  start: string,
  end: string,
): Promise<Map<string, LedgerDay>> {
  const from = timeZone === 'UTC' ? new Date(`${start}T00:00:00Z`) : dayStart(start);
  const to = timeZone === 'UTC' ? new Date(`${nextDay(end)}T00:00:00Z`) : dayStart(nextDay(end));
  const groups = await runAsSystem(() =>
    mongoose.models.Transaction.aggregate<{ _id: string; credits: number; units: number }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $addFields: { svc: serviceOf } },
      { $match: { svc: { $in: services } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: timeZone } },
          credits: { $sum: { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] } },
          units: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
        },
      },
    ]),
  );
  return new Map(
    groups.map((group) => [
      group._id,
      { usd: group.credits / CREDITS_PER_USD, units: group.units },
    ]),
  );
}

/** Last calendar day of a `YYYY-MM` month. */
const monthEnd = (month: string): string => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};

const todayIn = (timeZone: 'UTC' | 'Asia/Dhaka', now: Date): string =>
  timeZone === 'UTC' ? now.toISOString().slice(0, 10) : dhakaDay(now);

const round = (value: number | null, places = 6): number | null =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

const roundRow = <T extends Comparison>(row: T): T => ({
  ...row,
  ledger: round(row.ledger) ?? 0,
  provider: round(row.provider),
  gap: round(row.gap),
  gapPct: round(row.gapPct, 4),
});

export interface ServiceView {
  service: ReconcileService;
  label: string;
  unit: ReconcileUnit;
  source: { status: SyncState['status'] | 'never_run'; message?: string; lastRunAt?: Date };
  /** USD per unit at the ledger's own rates, so credits can be shown as money. */
  usdPerUnit: number | null;
  total: PeriodRow;
  weeks: PeriodRow[];
  days: Array<Comparison & { day: string }>;
  flagged: number;
}

async function serviceView(
  spec: ServiceSpec,
  range: Range,
  threshold: number,
  now: Date,
  states: Map<string, SyncState>,
  env: NodeJS.ProcessEnv,
): Promise<ServiceView> {
  const today = todayIn(spec.timeZone, now);
  const finished = eachDay(range.start, range.end).filter((day) => day < today);
  const [ledger, records] = await Promise.all([
    finished.length
      ? loadLedger(spec.ledger, spec.timeZone, finished[0], finished[finished.length - 1])
      : Promise.resolve(new Map<string, LedgerDay>()),
    finished.length
      ? loadSpend(spec.service, finished[0], finished[finished.length - 1])
      : Promise.resolve([] as ProviderSpendRecord[]),
  ]);
  const provider = new Map(records.map((record) => [record.period, record.amount]));
  const figures: DayFigure[] = finished.map((day) => {
    const row = ledger.get(day);
    return {
      day,
      ledger: spec.unit === 'usd' ? (row?.usd ?? 0) : (row?.units ?? 0),
      provider: provider.get(day) ?? null,
    };
  });

  const days = figures.map((figure) => ({
    day: figure.day,
    ...roundRow(compare(figure.ledger, figure.provider, threshold, spec.floor)),
  }));
  const weeks = aggregate(figures, weekStart, threshold, spec.floor).map(roundRow);
  const [total] = aggregate(figures, () => 'range', threshold, spec.floor).map(roundRow);
  const usd = [...ledger.values()].reduce((sum, row) => sum + row.usd, 0);
  const units = [...ledger.values()].reduce((sum, row) => sum + row.units, 0);
  const state = states.get(spec.service);
  const configured =
    Boolean(env[spec.envKey]?.trim()) && !env[spec.envKey]?.trim().startsWith('${');

  return {
    service: spec.service,
    label: spec.label,
    unit: spec.unit,
    source: state
      ? { status: state.status, message: state.message, lastRunAt: state.lastRunAt }
      : { status: configured ? 'never_run' : 'not_configured' },
    usdPerUnit: spec.unit === 'credits' && units > 0 ? round(usd / units, 8) : null,
    total:
      total ??
      roundRow({ period: 'range', days: 0, daysCovered: 0, ledgerAll: 0, ...compare(0, null) }),
    weeks,
    days,
    flagged: days.filter((day) => day.status === 'flagged' || day.status === 'missing_ledger')
      .length,
  };
}

export interface UnstructuredMonth extends PeriodRow {
  pages: number | null;
  note: string | null;
  enteredBy: string | null;
  enteredAt: Date | null;
}

async function unstructuredMonths(
  range: Range,
  threshold: number,
  now: Date,
): Promise<UnstructuredMonth[]> {
  const thisMonth = monthOf(dhakaDay(now));
  const months = [...new Set(eachDay(range.start, range.end).map(monthOf))].filter(
    (month) => month <= thisMonth,
  );
  if (!months.length) return [];
  const first = `${months[0]}-01`;
  const lastMonth = months[months.length - 1];
  const lastDay = monthEnd(lastMonth);
  const [ledger, records] = await Promise.all([
    loadLedger(['unstructured'], 'Asia/Dhaka', first, lastDay),
    loadSpend('unstructured', months[0], months[months.length - 1]),
  ]);
  const entries = new Map(records.map((record) => [record.period, record]));
  return months.map((month) => {
    const ledgerUsd = [...ledger.entries()]
      .filter(([day]) => monthOf(day) === month)
      .reduce((sum, [, row]) => sum + row.usd, 0);
    const entry = entries.get(month);
    const open = month === thisMonth;
    const base = roundRow({
      period: month,
      days: 0,
      daysCovered: entry ? 1 : 0,
      ledgerAll: ledgerUsd,
      ...compare(ledgerUsd, entry?.amount ?? null, threshold, 0.01),
    });
    return {
      ...base,
      /** An unfinished month cannot match its invoice yet, so it is shown but not judged. */
      status: open && entry ? 'empty' : base.status,
      pages: entry?.pages ?? null,
      note: entry?.note ?? null,
      enteredBy: entry?.enteredBy ?? null,
      enteredAt: entry?.fetchedAt ?? null,
    };
  });
}

export interface ReconciliationView {
  range: Range;
  thresholdPct: number;
  notes: string[];
  services: ServiceView[];
  unstructured: UnstructuredMonth[];
}

/** Ledger against what each provider reported, per day and per week, with gaps above the threshold flagged. */
export async function buildReconciliation(
  range: Range,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<ReconciliationView> {
  const states = new Map((await loadStates()).map((state) => [state.service, state]));
  const [services, unstructured] = await Promise.all([
    Promise.all(SPECS.map((spec) => serviceView(spec, range, threshold, now, states, env))),
    unstructuredMonths(range, threshold, now),
  ]);
  return {
    range,
    thresholdPct: threshold * 100,
    notes: [
      'OpenRouter reports by UTC day, so its days are compared with the ledger by UTC day; Firecrawl and Unstructured use Asia/Dhaka days.',
      'The OpenRouter ledger figure is the provider rate, without the top-up fee. Voice input is part of the OpenRouter bill.',
      'Days without provider data are shown as missing and left out of the week and range totals.',
    ],
    services,
    unstructured,
  };
}
