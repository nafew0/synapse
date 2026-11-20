import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { runUsageRollup, dhakaDay } from './rollup';
import { computeTaskCostProfile } from './costs';
import { readBdrenConfig } from '~/bdren/config';
import { runUsageExport } from '~/bdren/usage';

export const ROLLUP_INTERVAL_MS: number = 15 * 60 * 1000;
/** Today's usage goes back to bdren.ai this often; finished days are sent once and only re-sent after a failure. */
export const EXPORT_INTERVAL_MS: number = 60 * 60 * 1000;
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

async function exportTick(): Promise<void> {
  try {
    const run = await runUsageExport({ config: readBdrenConfig() });
    if (run.skipped === 'disabled') {
      return;
    }
    logger.info(
      `[bdren] Usage export ${run.skipped ?? `sent ${run.days.length} day(s), ${run.windows} window report(s)${run.failed ? `, stopped: ${run.failed}` : ''}`}`,
    );
  } catch (error) {
    logger.error('[bdren] Usage export failed', error);
  }
}

/**
 * Starts the usage jobs: the rollup once now and every 15 minutes, and, when `BDREN_USAGE_EXPORT_ENABLED`
 * is on, the export to bdren.ai hourly (the first run waits a few minutes so the rollup finishes first).
 * Returns a function that stops them.
 */
export function startUsageJobs(
  intervalMs: number = ROLLUP_INTERVAL_MS,
  exportIntervalMs: number = EXPORT_INTERVAL_MS,
): () => void {
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  const first = setTimeout(() => void exportTick(), 3 * 60 * 1000);
  first.unref();
  const exporter = setInterval(() => void exportTick(), exportIntervalMs);
  exporter.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
    clearInterval(exporter);
  };
}
