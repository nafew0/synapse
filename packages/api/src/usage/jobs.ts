import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { runUsageRollup, dhakaDay } from './rollup';
import { computeTaskCostProfile } from './costs';

export const ROLLUP_INTERVAL_MS: number = 15 * 60 * 1000;
/** Local hour (Asia/Dhaka) from which the nightly profile may run. */
const PROFILE_HOUR = 2;
const PROFILE_JOB = 'task-profile';

const dhakaHour = (at: Date): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      hour12: false,
    }).format(at),
  ) % 24;

/**
 * Runs the nightly profile once per Asia/Dhaka day, after 02:00. The day is claimed with one atomic
 * update, so several servers do not each rebuild it. A failed run gives the claim back.
 */
export async function runNightlyProfile(now: Date = new Date()): Promise<boolean> {
  if (dhakaHour(now) < PROFILE_HOUR) {
    return false;
  }
  const day = dhakaDay(now);
  const UsageJob = mongoose.models.UsageJob;
  await UsageJob.updateOne(
    { name: PROFILE_JOB },
    { $setOnInsert: { name: PROFILE_JOB } },
    { upsert: true },
  ).catch((error: { code?: number }) => {
    if (error.code !== 11000) {
      throw error;
    }
  });
  const claimed = await UsageJob.findOneAndUpdate(
    { name: PROFILE_JOB, lastDay: { $ne: day } },
    { $set: { lastDay: day, lastRunAt: now } },
  ).lean<{ lastDay?: string }>();
  if (!claimed) {
    return false;
  }
  try {
    await computeTaskCostProfile(now);
    return true;
  } catch (error) {
    await UsageJob.updateOne({ name: PROFILE_JOB }, { $set: { lastDay: claimed.lastDay ?? null } });
    throw error;
  }
}

async function tick(): Promise<void> {
  try {
    const result = await runUsageRollup();
    const bad = result.reconciliations.filter((check) => !check.ok);
    logger.info(
      `[Usage] Rollup ${result.skipped ?? `rebuilt ${result.days.length} day(s)`}${bad.length ? `, ${bad.length} mismatched` : ''}`,
    );
    if (await runNightlyProfile()) {
      logger.info('[Usage] Task cost profile rebuilt');
    }
  } catch (error) {
    logger.error('[Usage] Usage job failed', error);
  }
}

/** Starts the usage jobs: once now, then every 15 minutes. Returns a function that stops them. */
export function startUsageJobs(intervalMs: number = ROLLUP_INTERVAL_MS): () => void {
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
