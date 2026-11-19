import mongoose from 'mongoose';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { IUsageDaily } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import { CREDITS_PER_USD } from './packages';

/** One platform-wide zone for the daily rollup. Asia/Dhaka has no daylight saving, so it is UTC+6 all year. */
export const ROLLUP_TIMEZONE: string = 'Asia/Dhaka';
const DHAKA_OFFSET = '+06:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_NAME = 'usage-rollup';
const LEASE_MS = 10 * 60 * 1000;
/** Days always rebuilt, so a row tagged a moment after it was written still lands in the right bucket. */
const ALWAYS_REBUILT_DAYS = 2;

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROLLUP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Dhaka calendar day of an instant, `YYYY-MM-DD`. */
export const dhakaDay = (at: Date): string => dayFormat.format(at);

const dayStart = (day: string): Date => new Date(`${day}T00:00:00${DHAKA_OFFSET}`);
const nextDay = (day: string): string => dhakaDay(new Date(dayStart(day).getTime() + DAY_MS));

export interface DayTotals {
  rows: number;
  credits: number;
}

export interface Reconciliation {
  day: string;
  ledger: DayTotals;
  rollup: DayTotals;
  ok: boolean;
}

export interface RollupResult {
  skipped?: 'locked';
  days: string[];
  reconciliations: Reconciliation[];
}

interface Slice {
  _id: {
    day: string;
    tenantId?: string;
    user?: Types.ObjectId;
    service: string;
    modelKey?: string;
    usageKind?: string;
    taskType?: string;
    billable: boolean;
  };
  requests: number;
  units: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  credits: number;
  rows: number;
}

const bucketKey = ({ _id: id }: Slice): string =>
  [
    id.day,
    id.tenantId ?? '-',
    id.user?.toString() ?? '-',
    id.service,
    id.modelKey ?? '-',
    id.usageKind ?? '-',
    id.taskType ?? '-',
    id.billable ? 'b' : 'p',
  ].join('|');

const dhakaDayOfCreation = {
  $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: ROLLUP_TIMEZONE },
};

/** Rows older than the service field: OCR is Unstructured, every other row is a model call. */
const serviceOf = {
  $ifNull: [
    '$service',
    {
      $cond: [
        { $or: [{ $eq: ['$usageKind', 'ocr'] }, { $eq: ['$providerKey', 'unstructured'] }] },
        'unstructured',
        'openrouter',
      ],
    },
  ],
};

const absolute = (field: string) => ({ $abs: { $ifNull: [field, 0] } });

const isTokens = (type: string) => ({
  $cond: [{ $eq: ['$tokenType', type] }, absolute('$rawAmount'), 0],
});

function sliceStages(from: Date, to: Date) {
  return [
    { $match: { createdAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: {
          day: dhakaDayOfCreation,
          tenantId: '$tenantId',
          user: '$user',
          service: serviceOf,
          modelKey: '$modelKey',
          usageKind: '$usageKind',
          taskType: '$taskType',
          billable: { $ifNull: ['$billable', true] },
        },
        requests: { $sum: { $cond: [{ $eq: ['$tokenType', 'completion'] }, 0, 1] } },
        units: { $sum: absolute('$rawAmount') },
        inputTokens: { $sum: isTokens('prompt') },
        outputTokens: { $sum: isTokens('completion') },
        pages: { $sum: { $ifNull: ['$pages', 0] } },
        credits: { $sum: { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] } },
        rows: { $sum: 1 },
      },
    },
  ];
}

function toBucket(slice: Slice): IUsageDaily {
  const { _id: id } = slice;
  return {
    key: bucketKey(slice),
    day: id.day,
    tenantId: id.tenantId,
    user: id.user,
    service: id.service,
    modelKey: id.modelKey,
    usageKind: id.usageKind,
    taskType: id.taskType,
    billable: id.billable,
    requests: slice.requests,
    units: slice.units,
    inputTokens: slice.inputTokens,
    outputTokens: slice.outputTokens,
    pages: slice.pages,
    costUsd: slice.credits / CREDITS_PER_USD,
    rows: slice.rows,
  };
}

async function ledgerTotals(day: string, before: Date): Promise<DayTotals> {
  const [totals] = await runAsSystem(async () =>
    mongoose.models.Transaction.aggregate<DayTotals>([
      {
        $match: {
          createdAt: { $gte: dayStart(day), $lt: earlier(before, dayStart(nextDay(day))) },
        },
      },
      {
        $group: {
          _id: null,
          rows: { $sum: 1 },
          credits: { $sum: { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] } },
        },
      },
    ]),
  );
  return { rows: totals?.rows ?? 0, credits: totals?.credits ?? 0 };
}

const earlier = (a: Date, b: Date): Date => (a < b ? a : b);

async function rollupTotals(day: string): Promise<DayTotals> {
  const [totals] = await mongoose.models.UsageDaily.aggregate<{ rows: number; costUsd: number }>([
    { $match: { day } },
    { $group: { _id: null, rows: { $sum: '$rows' }, costUsd: { $sum: '$costUsd' } } },
  ]);
  return { rows: totals?.rows ?? 0, credits: Math.round((totals?.costUsd ?? 0) * CREDITS_PER_USD) };
}

/**
 * Rebuilds one day of the rollup from the ledger: every bucket is computed afresh and replaced, and
 * buckets the ledger no longer produces (a row that was re-tagged) are removed. Running it twice
 * gives the same rows. `before` stops the day at the moment the job started, so the check below
 * compares like with like.
 */
export async function rebuildDay(day: string, before: Date = new Date()): Promise<Reconciliation> {
  const from = dayStart(day);
  const to = earlier(before, dayStart(nextDay(day)));
  const slices = await runAsSystem(async () =>
    mongoose.models.Transaction.aggregate<Slice>(sliceStages(from, to)),
  );
  const buckets = slices.map(toBucket);
  const UsageDaily = mongoose.models.UsageDaily;
  if (buckets.length > 0) {
    await UsageDaily.bulkWrite(
      buckets.map((bucket) => ({
        replaceOne: { filter: { key: bucket.key }, replacement: bucket, upsert: true },
      })),
    );
  }
  await UsageDaily.deleteMany({ day, key: { $nin: buckets.map((bucket) => bucket.key) } });
  const ledger = await ledgerTotals(day, before);
  const rollup = await rollupTotals(day);
  const ok = ledger.rows === rollup.rows && Math.abs(ledger.credits - rollup.credits) <= 1;
  if (!ok) {
    logger.error(
      `[Usage] Rollup for ${day} does not match the ledger: ledger ${ledger.rows} rows / ${ledger.credits} credits, rollup ${rollup.rows} rows / ${rollup.credits} credits`,
    );
  }
  return { day, ledger, rollup, ok };
}

/** Days from `first` to `last` inclusive. */
function daysBetween(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = nextDay(day)) {
    days.push(day);
  }
  return days;
}

async function touchedDays(after: Types.ObjectId | undefined): Promise<string[]> {
  const groups = await runAsSystem(async () =>
    mongoose.models.Transaction.aggregate<{ _id: string }>([
      ...(after ? [{ $match: { _id: { $gt: after } } }] : []),
      { $group: { _id: dhakaDayOfCreation } },
    ]),
  );
  return groups.map((group) => group._id);
}

async function newestRow(): Promise<Types.ObjectId | undefined> {
  const [row] = await runAsSystem(async () =>
    mongoose.models.Transaction.find({}, { _id: 1 }).sort({ _id: -1 }).limit(1).lean(),
  );
  return row?._id as Types.ObjectId | undefined;
}

async function acquireLease(now: Date): Promise<{ watermark?: Types.ObjectId } | null> {
  const UsageJob = mongoose.models.UsageJob;
  await UsageJob.updateOne(
    { name: JOB_NAME },
    { $setOnInsert: { name: JOB_NAME } },
    { upsert: true },
  ).catch((error: { code?: number }) => {
    if (error.code !== 11000) {
      throw error;
    }
  });
  const job = await UsageJob.findOneAndUpdate(
    { name: JOB_NAME, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } },
    { new: true },
  ).lean<{ watermark?: Types.ObjectId }>();
  return job ? { watermark: job.watermark } : null;
}

/**
 * Brings the rollup up to date: rebuilds every day that has new ledger rows since the watermark,
 * plus today and yesterday, then moves the watermark. Safe to run twice and from two servers at
 * once (a lease lets one of them skip).
 */
export async function runUsageRollup(now: Date = new Date()): Promise<RollupResult> {
  const lease = await acquireLease(now);
  if (!lease) {
    return { skipped: 'locked', days: [], reconciliations: [] };
  }
  const UsageJob = mongoose.models.UsageJob;
  try {
    const newest = await newestRow();
    const today = dhakaDay(now);
    const recent = daysBetween(
      dhakaDay(new Date(now.getTime() - (ALWAYS_REBUILT_DAYS - 1) * DAY_MS)),
      today,
    );
    const days = [...new Set([...(await touchedDays(lease.watermark)), ...recent])].sort();
    const reconciliations: Reconciliation[] = [];
    for (const day of days) {
      reconciliations.push(await rebuildDay(day, now));
    }
    await UsageJob.updateOne(
      { name: JOB_NAME },
      {
        $set: { lastRunAt: now, ...(newest ? { watermark: newest } : {}) },
        $unset: { lockedUntil: 1 },
      },
    );
    return { days, reconciliations };
  } catch (error) {
    await UsageJob.updateOne({ name: JOB_NAME }, { $unset: { lockedUntil: 1 } });
    throw error;
  }
}

export interface MonthTotals {
  month: string;
  service: string;
  rows: number;
  costUsd: number;
}

export interface BackfillResult {
  dryRun: boolean;
  from?: string;
  to?: string;
  days: number;
  months: MonthTotals[];
  reconciliations: Reconciliation[];
}

/** Totals per month and service straight from the ledger, for the dry run. */
async function monthlyTotals(): Promise<MonthTotals[]> {
  const groups = await runAsSystem(async () =>
    mongoose.models.Transaction.aggregate<{
      _id: { month: string; service: string };
      rows: number;
      credits: number;
    }>([
      {
        $group: {
          _id: {
            month: {
              $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: ROLLUP_TIMEZONE },
            },
            service: serviceOf,
          },
          rows: { $sum: 1 },
          credits: { $sum: { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] } },
        },
      },
      { $sort: { '_id.month': 1, '_id.service': 1 } },
    ]),
  );
  return groups.map((group) => ({
    month: group._id.month,
    service: group._id.service,
    rows: group.rows,
    costUsd: group.credits / CREDITS_PER_USD,
  }));
}

/**
 * Builds the rollup for every day from the first ledger row to today. With `dryRun` it only reports
 * the totals per month and service and writes nothing. A full run also leaves the watermark at the
 * newest row, so the 15-minute job carries on from there.
 */
export async function backfillUsageDaily(
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<BackfillResult> {
  const { dryRun = false, now = new Date() } = options;
  const [first] = await runAsSystem(async () =>
    mongoose.models.Transaction.find({}, { createdAt: 1 }).sort({ createdAt: 1 }).limit(1).lean(),
  );
  if (!first?.createdAt) {
    return { dryRun, days: 0, months: [], reconciliations: [] };
  }
  const from = dhakaDay(first.createdAt as Date);
  const to = dhakaDay(now);
  const days = daysBetween(from, to);
  const months = await monthlyTotals();
  if (dryRun) {
    return { dryRun, from, to, days: days.length, months, reconciliations: [] };
  }
  const newest = await newestRow();
  const reconciliations: Reconciliation[] = [];
  for (const day of days) {
    reconciliations.push(await rebuildDay(day, now));
  }
  if (newest) {
    await mongoose.models.UsageJob.updateOne(
      { name: JOB_NAME },
      { $set: { watermark: newest, lastRunAt: now } },
      { upsert: true },
    );
  }
  return { dryRun, from, to, days: days.length, months, reconciliations };
}
