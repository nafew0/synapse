import crypto from 'crypto';
import mongoose from 'mongoose';
import { TASK_TYPES, logger, runAsSystem } from '@librechat/data-schemas';
import type { TaskType, ITaskCostProfile } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import { CREDITS_PER_USD } from './packages';
import { dhakaDay } from './rollup';

interface RequestCost {
  usd: number;
  pages: number;
  webCredits: number;
  images: number;
}

export const PROFILE_WINDOW_DAYS: number = 30;
/** Fewer requests than this and a task type's numbers do not replace the estimate. */
export const PROFILE_MIN_REQUESTS: number = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_DAYS = 90;

/** Linear-interpolation percentile (`p` in 0..1) of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export function buildProfile(
  taskType: TaskType,
  day: string,
  costs: RequestCost[],
): ITaskCostProfile {
  const sorted = costs.map((cost) => cost.usd).sort((a, b) => a - b);
  const pages = sum(costs.map((cost) => cost.pages));
  const pagedCost = sum(costs.filter((cost) => cost.pages > 0).map((cost) => cost.usd));
  const requests = costs.length;
  return {
    day,
    taskType,
    windowDays: PROFILE_WINDOW_DAYS,
    requests,
    medianUsd: percentile(sorted, 0.5),
    p90Usd: percentile(sorted, 0.9),
    meanUsd: requests === 0 ? 0 : sum(sorted) / requests,
    perPageUsd: pages > 0 ? pagedCost / pages : undefined,
    avgPages: requests === 0 ? 0 : pages / requests,
    avgWebCredits: requests === 0 ? 0 : sum(costs.map((cost) => cost.webCredits)) / requests,
    avgImages: requests === 0 ? 0 : sum(costs.map((cost) => cost.images)) / requests,
    sufficient: requests >= PROFILE_MIN_REQUESTS,
  };
}

/**
 * Cost of every tagged request in the window, billable rows only (what an allowance pays for). A
 * request is the reply's message id; a row without one (a voice clip) is a request of its own.
 */
async function requestCosts(now: Date): Promise<Map<TaskType, RequestCost[]>> {
  const since = new Date(now.getTime() - PROFILE_WINDOW_DAYS * DAY_MS);
  const rows = await runAsSystem(async () =>
    mongoose.models.Transaction.aggregate<{
      _id: { request: unknown; taskType: TaskType };
      credits: number;
      pages: number;
      webCredits: number;
      images: number;
    }>([
      {
        $match: {
          createdAt: { $gte: since, $lte: now },
          taskType: { $exists: true },
          billable: { $ne: false },
        },
      },
      {
        $group: {
          _id: {
            taskType: '$taskType',
            request: { $ifNull: ['$messageId', '$_id'] },
            user: '$user',
          },
          credits: { $sum: { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] } },
          pages: { $sum: { $ifNull: ['$pages', 0] } },
          webCredits: {
            $sum: {
              $cond: [{ $eq: ['$service', 'firecrawl'] }, { $ifNull: ['$rawAmount', 0] }, 0],
            },
          },
          images: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$context', 'image_generation'] },
                    { $eq: ['$tokenType', 'prompt'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  );
  const byType = new Map<TaskType, RequestCost[]>();
  for (const row of rows) {
    const list = byType.get(row._id.taskType) ?? [];
    list.push(perRequest(row.credits, row.pages, row.webCredits, row.images));
    byType.set(row._id.taskType, list);
  }
  return byType;
}

const perRequest = (
  credits: number,
  pages: number,
  webCredits: number,
  images: number,
): RequestCost => ({
  usd: credits / CREDITS_PER_USD,
  pages,
  webCredits,
  images,
});

/**
 * Rebuilds today's task cost profile from the last 30 days of tagged requests and stores one row per
 * task type that has any. Replaces the day's rows, so a second run the same day changes nothing.
 */
export async function computeTaskCostProfile(now: Date = new Date()): Promise<ITaskCostProfile[]> {
  const day = dhakaDay(now);
  const byType = await requestCosts(now);
  const profiles = [...byType.entries()].map(([taskType, costs]) =>
    buildProfile(taskType, day, costs),
  );
  const TaskCostProfile = mongoose.models.TaskCostProfile;
  if (profiles.length > 0) {
    await TaskCostProfile.bulkWrite(
      profiles.map((profile) => ({
        replaceOne: {
          filter: { day, taskType: profile.taskType },
          replacement: profile,
          upsert: true,
        },
      })),
    );
  }
  await TaskCostProfile.deleteMany({
    day,
    taskType: { $nin: profiles.map((profile) => profile.taskType) },
  });
  return profiles;
}

export interface TaskCostEntry {
  taskType: TaskType;
  requests: number;
  /** `measured` once there are enough requests; otherwise the reader keeps its own estimate. */
  source: 'measured' | 'estimate';
  medianUsd: number | null;
  p90Usd: number | null;
  meanUsd: number | null;
  medianCredits: number | null;
  p90Credits: number | null;
  perPageUsd: number | null;
  avgPages: number;
  avgWebCredits: number;
  avgImages: number;
}

export interface TaskCostResponse {
  day: string | null;
  windowDays: number;
  minRequests: number;
  creditsPerUsd: number;
  taskTypes: TaskCostEntry[];
  trend?: {
    day: string;
    taskType: TaskType;
    medianUsd: number;
    p90Usd: number;
    requests: number;
  }[];
}

const toCredits = (usd: number): number => Math.round(usd * CREDITS_PER_USD);

function toEntry(taskType: TaskType, profile?: ITaskCostProfile): TaskCostEntry {
  if (!profile?.sufficient) {
    return {
      taskType,
      requests: profile?.requests ?? 0,
      source: 'estimate',
      medianUsd: null,
      p90Usd: null,
      meanUsd: null,
      medianCredits: null,
      p90Credits: null,
      perPageUsd: null,
      avgPages: 0,
      avgWebCredits: 0,
      avgImages: 0,
    };
  }
  return {
    taskType,
    requests: profile.requests,
    source: 'measured',
    medianUsd: profile.medianUsd,
    p90Usd: profile.p90Usd,
    meanUsd: profile.meanUsd,
    medianCredits: toCredits(profile.medianUsd),
    p90Credits: toCredits(profile.p90Usd),
    perPageUsd: profile.perPageUsd ?? null,
    avgPages: profile.avgPages,
    avgWebCredits: profile.avgWebCredits,
    avgImages: profile.avgImages,
  };
}

/** The latest stored profile, one entry for each of the 13 task types, plus an optional daily trend. */
export async function getTaskCostProfile(historyDays = 0): Promise<TaskCostResponse> {
  const TaskCostProfile = mongoose.models.TaskCostProfile;
  const latest = await TaskCostProfile.findOne({}, { day: 1 })
    .sort({ day: -1 })
    .lean<Pick<ITaskCostProfile, 'day'>>();
  const day = latest?.day ?? null;
  const rows = day ? await TaskCostProfile.find({ day }).lean<ITaskCostProfile[]>() : [];
  const byType = new Map(rows.map((row) => [row.taskType as TaskType, row]));
  const response: TaskCostResponse = {
    day,
    windowDays: PROFILE_WINDOW_DAYS,
    minRequests: PROFILE_MIN_REQUESTS,
    creditsPerUsd: CREDITS_PER_USD,
    taskTypes: TASK_TYPES.map((taskType) => toEntry(taskType, byType.get(taskType))),
  };
  if (historyDays > 0 && day) {
    const days = ((await TaskCostProfile.distinct('day', { sufficient: true })) as string[])
      .sort()
      .slice(-historyDays);
    const history = await TaskCostProfile.find({ sufficient: true, day: { $in: days } })
      .sort({ day: -1, taskType: 1 })
      .lean<ITaskCostProfile[]>();
    response.trend = history
      .map(({ day: d, taskType, medianUsd, p90Usd, requests }) => ({
        day: d,
        taskType: taskType as TaskType,
        medianUsd,
        p90Usd,
        requests,
      }))
      .reverse();
  }
  return response;
}

function keyMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function presentedKey(req: Request): string {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const header = req.headers['x-product-key'];
  return (bearer ?? (Array.isArray(header) ? header[0] : header) ?? '').trim();
}

/**
 * Guards the endpoints bdren.ai calls as a product. The key is read on each request, so rotating it
 * needs no restart. With no key configured every request is refused: the guard fails closed.
 */
export function createProductKeyGuard(getKey: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = getKey()?.trim();
    if (!expected) {
      res.status(503).json({ error: 'Product key is not configured' });
      return;
    }
    const given = presentedKey(req);
    if (!given || !keyMatches(given, expected)) {
      res.status(401).json({ error: 'Invalid product key' });
      return;
    }
    next();
  };
}

export function createTaskCostHandlers() {
  return {
    async getTaskCosts(req: Request, res: Response): Promise<void> {
      const history = Math.min(
        Math.max(Number.parseInt(String(req.query.history ?? '0'), 10) || 0, 0),
        MAX_HISTORY_DAYS,
      );
      try {
        res.json(await getTaskCostProfile(history));
      } catch (error) {
        logger.error('[Usage] Failed to read the task cost profile', error);
        res.status(500).json({ error: 'Could not read task costs' });
      }
    },
  };
}
