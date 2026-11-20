import mongoose from 'mongoose';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { BdrenAllowancePayload } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { BdrenConfig } from './types';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { dhakaDay, nextDay } from '~/usage/rollup';
import { CREDITS_PER_USD } from '~/usage/packages';
import { bucketRanges } from './windows';

const JOB_NAME = 'bdren-usage-export';
const LEASE_MS = 10 * 60 * 1000;
const CHUNK = 500;
const MAX_CATCH_UP_DAYS = 60;
const ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000];
const POST_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export interface TaskReport {
  task_type: string;
  credits: number;
  requests: number;
  pages: number;
}

export interface WindowReport {
  window: 'month' | 'week';
  start: string;
  end: string | null;
  used: number;
}

/** One person on one request. `tasks` absent leaves bdren.ai's rows for the day alone. */
export interface MemberReport {
  issuer: string;
  zitadel_subject: string;
  tasks?: TaskReport[];
  allowance?: WindowReport[];
}

export interface PostSummary {
  stored: number;
  unknown: string[];
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

interface Deps {
  config: BdrenConfig;
  fetchFn?: FetchFn;
  sleep?: Sleep;
}

const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** bdren.ai refused the data itself (a 4xx other than 429); sending it again will not help. */
export class ExportRejected extends Error {}

const taskName = (raw: string | null | undefined): string => {
  const name = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '');
  return name.slice(0, 40) || 'other';
};

const chunked = <T>(items: T[], size: number = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

interface Linked {
  issuer: string;
  subject: string;
}

/** Users that signed in through the bdren.ai issuer, by id. Everyone else is not reported. */
async function linkedUsers(ids: Types.ObjectId[], issuer: string): Promise<Map<string, Linked>> {
  const wanted = normalizeOpenIdIssuer(issuer);
  const found = new Map<string, Linked>();
  for (const part of chunked(ids, 1000)) {
    const users = await runAsSystem(() =>
      mongoose.models.User.find({ _id: { $in: part }, openidId: { $exists: true, $ne: null } })
        .select('openidId openidIssuer')
        .lean<Array<{ _id: Types.ObjectId; openidId: string; openidIssuer?: string }>>()
        .exec(),
    );
    for (const user of users) {
      if (normalizeOpenIdIssuer(user.openidIssuer) === wanted) {
        found.set(String(user._id), { issuer, subject: user.openidId });
      }
    }
  }
  return found;
}

interface DayGroup {
  _id: { user: Types.ObjectId; taskType: string };
  costUsd: number;
  requests: number;
  pages: number;
}

/**
 * One day of the rollup as bdren.ai wants it: per linked member and task type, the credits the allowance
 * was charged (billable rows only; pass-through rows are not drawn from it), requests and scanned pages.
 */
export async function buildDay(day: string, issuer: string): Promise<MemberReport[]> {
  const groups = await runAsSystem(() =>
    mongoose.models.UsageDaily.aggregate<DayGroup>([
      { $match: { day, billable: true, user: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { user: '$user', taskType: { $ifNull: ['$taskType', 'other'] } },
          costUsd: { $sum: '$costUsd' },
          requests: { $sum: '$requests' },
          pages: { $sum: '$pages' },
        },
      },
      { $sort: { '_id.user': 1, '_id.taskType': 1 } },
    ]),
  );
  const linked = await linkedUsers([...new Set(groups.map((g) => g._id.user))], issuer);
  const members = new Map<string, MemberReport>();
  for (const group of groups) {
    const who = linked.get(String(group._id.user));
    if (!who) {
      continue;
    }
    const report = members.get(String(group._id.user)) ?? {
      issuer: who.issuer,
      zitadel_subject: who.subject,
      tasks: [],
    };
    report.tasks!.push({
      task_type: taskName(group._id.taskType),
      credits: Math.round(group.costUsd * CREDITS_PER_USD),
      requests: group.requests,
      pages: group.pages,
    });
    members.set(String(group._id.user), report);
  }
  return [...members.values()];
}

interface AllowanceEntry {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tenantId: string;
  issuer: string;
  subject: string;
  allowance: BdrenAllowancePayload;
}

const asDate = (raw: string | null | undefined): Date | null => {
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * What the meter counted in each linked member's current month and week windows, one batch of cached
 * allowances at a time. The window is reported as bdren.ai gave it (the meter's week bucket may be nudged
 * a millisecond; that stays internal), and `used` is 0 for a window the member has not drawn from yet.
 */
export async function* windowReports(
  config: BdrenConfig,
  now: Date,
): AsyncGenerator<MemberReport[]> {
  const wanted = normalizeOpenIdIssuer(config.issuer);
  let after: Types.ObjectId | undefined;
  for (;;) {
    const entries = await runAsSystem(() =>
      mongoose.models.BdrenAllowance.find(after ? { _id: { $gt: after } } : {})
        .sort({ _id: 1 })
        .limit(CHUNK)
        .select('userId tenantId issuer subject allowance')
        .lean<AllowanceEntry[]>()
        .exec(),
    );
    if (entries.length === 0) {
      return;
    }
    after = entries[entries.length - 1]._id;
    const planned = entries
      .filter((entry) => normalizeOpenIdIssuer(entry.issuer) === wanted)
      .flatMap((entry) => planWindows(entry, now));
    if (planned.length === 0) {
      continue;
    }
    const buckets = await runAsSystem(() =>
      mongoose.models.UsageBucket.find({
        scopeType: 'member_credits',
        scopeKey: { $in: [...new Set(planned.map((p) => String(p.entry.userId)))] },
        periodStart: {
          $in: [...new Set(planned.map((p) => p.bucketStart))].map((t) => new Date(t)),
        },
      })
        .select('tenantId scopeKey periodStart usedTokens')
        .lean<
          Array<{ tenantId: string; scopeKey: string; periodStart: Date; usedTokens: number }>
        >()
        .exec(),
    );
    const used = new Map(
      buckets.map((b) => [`${b.tenantId}|${b.scopeKey}|${b.periodStart.getTime()}`, b.usedTokens]),
    );
    const reports = new Map<string, MemberReport>();
    for (const plan of planned) {
      const key = String(plan.entry.userId);
      const report = reports.get(key) ?? {
        issuer: plan.entry.issuer,
        zitadel_subject: plan.entry.subject,
        allowance: [],
      };
      report.allowance!.push({
        window: plan.window,
        start: plan.start,
        end: plan.end,
        used: Math.round(used.get(`${plan.entry.tenantId}|${key}|${plan.bucketStart}`) ?? 0),
      });
      reports.set(key, report);
    }
    yield [...reports.values()];
  }
}

interface PlannedWindow {
  entry: AllowanceEntry;
  window: 'month' | 'week';
  start: string;
  end: string | null;
  bucketStart: number;
}

function planWindows(entry: AllowanceEntry, now: Date): PlannedWindow[] {
  const credits = entry.allowance?.limits?.ai_credits;
  const month = asDate(entry.allowance?.windows?.month?.start);
  const monthEnd = entry.allowance?.windows?.month?.end;
  const week = asDate(entry.allowance?.windows?.week?.start);
  const weekEnd = entry.allowance?.windows?.week?.end;
  if (!credits || !month || !week) {
    return [];
  }
  const ranges = bucketRanges(
    { start: month, end: asDate(monthEnd) ?? FAR_FUTURE },
    { start: week, end: asDate(weekEnd) ?? FAR_FUTURE },
  );
  const out: PlannedWindow[] = [];
  const add = (window: 'month' | 'week', start: string, end: string | null, bucket: Date) => {
    const over = end != null && new Date(end) <= now;
    if (!over) {
      out.push({ entry, window, start, end, bucketStart: bucket.getTime() });
    }
  };
  add('month', entry.allowance.windows.month.start, monthEnd, ranges.month.start);
  add('week', entry.allowance.windows.week.start, weekEnd, ranges.week.start);
  return out;
}

/** Posts one request, retrying network errors, 429 and 5xx with a short backoff. */
export async function postReport(
  { config, fetchFn = fetch, sleep = wait }: Deps,
  day: string,
  members: MemberReport[],
): Promise<PostSummary> {
  let reason = 'unreachable';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
    try {
      const response = await fetchFn(`${config.baseUrl}/api/v1/usage/daily/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Product-Api-Key': config.productKey },
        redirect: 'error',
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        body: JSON.stringify({ day, members }),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          members_stored?: number;
          unknown_members?: string[];
        };
        return { stored: body.members_stored ?? 0, unknown: body.unknown_members ?? [] };
      }
      reason = `http_${response.status}`;
      if (response.status !== 429 && response.status < 500) {
        throw new ExportRejected(`bdren.ai refused the usage for ${day} (${reason})`);
      }
    } catch (error) {
      if (error instanceof ExportRejected) {
        throw error;
      }
      reason = (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
  }
  throw new Error(`bdren.ai could not take the usage for ${day} (${reason})`);
}

export interface DaySent {
  day: string;
  members: number;
  stored: number;
  unknown: number;
  credits: number;
}

const creditsOf = (members: MemberReport[]): number =>
  members.reduce((sum, m) => sum + (m.tasks ?? []).reduce((s, t) => s + t.credits, 0), 0);

/** Sends one day, in chunks. Re-sending it replaces it on bdren.ai. */
export async function exportDay(deps: Deps, day: string): Promise<DaySent> {
  const members = await buildDay(day, deps.config.issuer);
  const sent: DaySent = {
    day,
    members: members.length,
    stored: 0,
    unknown: 0,
    credits: creditsOf(members),
  };
  for (const part of chunked(members)) {
    const summary = await postReport(deps, day, part);
    sent.stored += summary.stored;
    sent.unknown += summary.unknown.length;
  }
  return sent;
}

async function exportWindows(deps: Deps, now: Date): Promise<number> {
  const today = dhakaDay(now);
  let sent = 0;
  for await (const batch of windowReports(deps.config, now)) {
    await postReport(deps, today, batch);
    sent += batch.length;
  }
  return sent;
}

async function acquireLease(now: Date): Promise<{ lastDay?: string } | null> {
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
  ).lean<{ lastDay?: string }>();
  return job ? { lastDay: job.lastDay } : null;
}

export interface ExportRun {
  skipped?: 'locked' | 'disabled';
  days: DaySent[];
  windows: number;
  failed?: string;
}

const daysBetween = (first: string, last: string): string[] => {
  const days: string[] = [];
  for (let day = first; day <= last; day = nextDay(day)) {
    days.push(day);
  }
  return days;
};

/**
 * Sends yesterday and today (today is refreshed every run), plus every day since the last day that went
 * through cleanly, then each member's window usage. A day that fails stops the run and is retried on the
 * next one, so no day is skipped; `lastDay` only moves past a finished day. Older gaps (more than
 * MAX_CATCH_UP_DAYS) are for `backfillBdrenUsage`.
 */
export async function runUsageExport(deps: Deps & { now?: Date }): Promise<ExportRun> {
  const { config, now = new Date() } = deps;
  if (!config.usageExport) {
    return { skipped: 'disabled', days: [], windows: 0 };
  }
  const lease = await acquireLease(now);
  if (!lease) {
    return { skipped: 'locked', days: [], windows: 0 };
  }
  const UsageJob = mongoose.models.UsageJob;
  const today = dhakaDay(now);
  const yesterday = dhakaDay(new Date(now.getTime() - DAY_MS));
  const resume = lease.lastDay ? nextDay(lease.lastDay) : yesterday;
  const floor = dhakaDay(new Date(now.getTime() - MAX_CATCH_UP_DAYS * DAY_MS));
  const first = [resume < yesterday ? resume : yesterday, floor].sort().pop()!;
  const run: ExportRun = { days: [], windows: 0 };
  try {
    for (const day of daysBetween(first, today)) {
      run.days.push(await exportDay(deps, day));
      if (day < today) {
        await UsageJob.updateOne({ name: JOB_NAME }, { $set: { lastDay: day } });
      }
    }
    run.windows = await exportWindows(deps, now);
    await UsageJob.updateOne(
      { name: JOB_NAME },
      { $set: { lastRunAt: now }, $unset: { lastError: 1, lockedUntil: 1 } },
    );
  } catch (error) {
    run.failed = (error as Error).message;
    logger.error(`[bdren] usage export stopped: ${run.failed}`);
    await UsageJob.updateOne(
      { name: JOB_NAME },
      { $set: { lastError: run.failed }, $unset: { lockedUntil: 1 } },
    );
  }
  return run;
}

export interface BackfillExport {
  dryRun: boolean;
  days: DaySent[];
}

/** Sends (or, with `dryRun`, only counts) every day from `from` to `to` inclusive, without touching `lastDay`. */
export async function backfillBdrenUsage(
  deps: Deps & { from: string; to: string; dryRun?: boolean },
): Promise<BackfillExport> {
  const { from, to, dryRun = false } = deps;
  const days: DaySent[] = [];
  for (const day of daysBetween(from, to)) {
    if (!dryRun) {
      days.push(await exportDay(deps, day));
      continue;
    }
    const members = await buildDay(day, deps.config.issuer);
    days.push({ day, members: members.length, stored: 0, unknown: 0, credits: creditsOf(members) });
  }
  return { dryRun, days };
}
