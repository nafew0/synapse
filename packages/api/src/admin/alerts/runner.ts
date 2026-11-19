import { logger } from '@librechat/data-schemas';
import type { AlertKind, AlertThresholds, CheckOutcome } from './types';
import type { SyncResult } from './store';
import {
  FIRECRAWL_BASE_URL,
  OPENROUTER_BASE_URL,
  readFirecrawlCredits,
  readOpenRouterCredits,
  readOpenRouterKey,
} from './providers';
import {
  dayInRollupZone,
  loadLabels,
  loadOpenRouterAverage,
  loadSpend,
  windowStart,
} from './spend';
import { evaluateFirecrawl, evaluateOpenRouter, evaluateSpikes } from './rules';
import { DEFAULT_THRESHOLDS } from './types';
import { syncAlerts } from './store';

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 30_000;

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

/** Thresholds from the environment, falling back to the plan's defaults. */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): AlertThresholds {
  return {
    balanceDays: number(env.ALERT_BALANCE_DAYS, DEFAULT_THRESHOLDS.balanceDays),
    lowShare: number(env.ALERT_LOW_SHARE, DEFAULT_THRESHOLDS.lowShare),
    expiryDays: number(env.ALERT_KEY_EXPIRY_DAYS, DEFAULT_THRESHOLDS.expiryDays),
    spikeMultiplier: number(env.ALERT_SPIKE_MULTIPLIER, DEFAULT_THRESHOLDS.spikeMultiplier),
    spikeMinUsd: number(env.ALERT_SPIKE_MIN_USD, DEFAULT_THRESHOLDS.spikeMinUsd),
    spikeAbsoluteUsd: number(env.ALERT_SPIKE_ABSOLUTE_USD, DEFAULT_THRESHOLDS.spikeAbsoluteUsd),
    spikeWindowDays: number(env.ALERT_SPIKE_WINDOW_DAYS, DEFAULT_THRESHOLDS.spikeWindowDays),
  };
}

/** A blank value or an unexpanded `${NAME}` placeholder means the setting is not configured. */
const configured = (value: string | undefined): string | undefined =>
  value && !value.trim().startsWith('${') && value.trim() !== '' ? value.trim() : undefined;

export interface CheckRunSummary extends SyncResult {
  checkedKinds: AlertKind[];
}

/** One pass: read each provider's key and credit endpoints, read the ledger, and update the alerts. Never throws. */
export async function runAlertChecks(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<CheckRunSummary> {
  const thresholds = thresholdsFromEnv(env);
  const outcomes: CheckOutcome[] = [];

  const openRouterKey = configured(env.OPENROUTER_KEY) ?? configured(env.OPENROUTER_API_KEY);
  const firecrawlKey = configured(env.FIRECRAWL_API_KEY);
  const today = dayInRollupZone(now);
  const since = windowStart(today, thresholds.spikeWindowDays);
  const spend = await loadSpend(since).catch((error) => {
    logger.error('[alerts] Failed to read spend', error);
    return null;
  });

  if (openRouterKey) {
    const config = {
      apiKey: openRouterKey,
      baseUrl: configured(env.OPENROUTER_API_URL) ?? OPENROUTER_BASE_URL,
    };
    const averageDailyUsd = await loadOpenRouterAverage(
      since,
      today,
      thresholds.spikeWindowDays,
    ).catch(() => 0);
    const [key, credits] = await Promise.all([
      readOpenRouterKey(config),
      readOpenRouterCredits(config),
    ]);
    outcomes.push(
      evaluateOpenRouter(
        {
          key,
          credits,
          averageDailyUsd,
        },
        now,
        thresholds,
      ),
    );
  }

  if (firecrawlKey) {
    const reading = await readFirecrawlCredits({
      apiKey: firecrawlKey,
      baseUrl: configured(env.FIRECRAWL_API_URL) ?? FIRECRAWL_BASE_URL,
    });
    const plan = number(env.ALERT_FIRECRAWL_PLAN_CREDITS, NaN);
    outcomes.push(evaluateFirecrawl(reading, Number.isFinite(plan) ? plan : null, thresholds));
  }

  if (spend) {
    const rows = spend.filter((row) => row.day === today);
    const labels = await loadLabels(rows.map((row) => `${row.scope}:${row.id}`)).catch(
      () => new Map<string, string>(),
    );
    outcomes.push(evaluateSpikes(spend, today, labels, thresholds));
  }

  const checkedKinds = outcomes.flatMap((outcome) => outcome.kinds);
  const findings = outcomes.flatMap((outcome) => outcome.findings);
  const result = await syncAlerts(findings, checkedKinds, now);
  return { ...result, checkedKinds };
}

/** Runs the checks on a timer. Alerts only ever land in the admin panel; nothing here sends email. */
export function startAlertScheduler(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout[] {
  if (env.ALERTS_ENABLED === 'false') return [];
  const intervalMs = Math.max(number(env.ALERTS_INTERVAL_MS, DEFAULT_INTERVAL_MS), 60_000);
  const run = () =>
    runAlertChecks(env).catch((error) => logger.error('[alerts] Check run failed', error));
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const repeat = setInterval(run, intervalMs);
  first.unref();
  repeat.unref();
  return [first, repeat];
}
