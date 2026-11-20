import { logger } from '@librechat/data-schemas';
import type { ProviderConfig } from '~/admin/alerts/providers';
import type { ProviderReading } from '~/admin/alerts/types';
import type { ReconcileService, SyncState } from './types';
import {
  FIRECRAWL_BASE_URL,
  OPENROUTER_BASE_URL,
  readFirecrawlCredits,
} from '~/admin/alerts/providers';
import { loadSpend, saveSpend, saveState } from './store';
import { readOpenRouterActivity } from './openrouter';
import { dayStart, dhakaDay } from '~/usage/rollup';
import { firecrawlDayCredits } from './maths';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 3;
const MAX_DAYS = 31;
const REFRESH_INTERVAL_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
/** Firecrawl is read in the first hours after midnight (Asia/Dhaka), so the reading is the end of the day before. */
const FIRECRAWL_WINDOW_HOURS = 2;

export interface SyncOptions {
  /** How many complete days back to ask OpenRouter for, default 3. */
  days?: number;
  /** Take the Firecrawl reading as the end of this day, outside the nightly window. */
  firecrawlAsOfDay?: string;
}

export interface SyncServiceResult {
  service: ReconcileService;
  status: SyncState['status'] | 'skipped';
  stored: number;
  message?: string;
}

/** A blank value or an unexpanded `${NAME}` placeholder means the setting is not configured. */
const configured = (value: string | undefined): string | undefined =>
  value && value.trim() !== '' && !value.trim().startsWith('${') ? value.trim() : undefined;

const dhakaHour = (at: Date): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      hour12: false,
    }).format(at),
  ) % 24;

const previousDay = (day: string): string => dhakaDay(new Date(dayStart(day).getTime() - DAY_MS));

function describe(
  reading: ProviderReading<unknown>,
): Pick<SyncState, 'status' | 'message' | 'httpStatus'> {
  switch (reading.status) {
    case 'ok':
      return { status: 'ok' };
    case 'rejected':
      return { status: 'rejected', httpStatus: reading.httpStatus, message: reading.message };
    case 'unreadable':
      return { status: 'unreadable', httpStatus: reading.httpStatus };
    default:
      return { status: 'unreachable', message: reading.message };
  }
}

async function syncOpenRouter(
  env: NodeJS.ProcessEnv,
  now: Date,
  days: number,
): Promise<SyncServiceResult> {
  const apiKey = configured(env.OPENROUTER_MANAGEMENT_KEY);
  if (!apiKey) {
    const message =
      'OPENROUTER_MANAGEMENT_KEY is not set; the activity endpoint needs a management key';
    await saveState({ service: 'openrouter', lastRunAt: now, status: 'not_configured', message });
    return { service: 'openrouter', status: 'not_configured', stored: 0, message };
  }
  const config: ProviderConfig = {
    apiKey,
    baseUrl: configured(env.OPENROUTER_API_URL) ?? OPENROUTER_BASE_URL,
  };
  /** OpenRouter reports by UTC day; only days that have ended are final. */
  const today = now.toISOString().slice(0, 10);
  const wanted = Array.from({ length: days }, (_, index) =>
    new Date(new Date(`${today}T00:00:00Z`).getTime() - (index + 1) * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );
  let stored = 0;
  let last: SyncState = { service: 'openrouter', lastRunAt: now, status: 'ok' };
  for (const day of wanted) {
    const reading = await readOpenRouterActivity(config, day);
    if (reading.status !== 'ok') {
      last = { service: 'openrouter', lastRunAt: now, ...describe(reading) };
      break;
    }
    await saveSpend({
      service: 'openrouter',
      period: day,
      kind: 'day',
      amount: reading.value.usd,
      source: 'openrouter_activity',
      requests: reading.value.requests,
      byModel: reading.value.byModel.slice(0, 20),
      fetchedAt: now,
    });
    stored += 1;
  }
  await saveState(last);
  return { service: 'openrouter', status: last.status, stored, message: last.message };
}

async function syncFirecrawl(
  env: NodeJS.ProcessEnv,
  now: Date,
  asOfDay?: string,
): Promise<SyncServiceResult> {
  const apiKey = configured(env.FIRECRAWL_API_KEY);
  if (!apiKey) {
    const message = 'FIRECRAWL_API_KEY is not set';
    await saveState({ service: 'firecrawl', lastRunAt: now, status: 'not_configured', message });
    return { service: 'firecrawl', status: 'not_configured', stored: 0, message };
  }
  const inWindow = dhakaHour(now) < FIRECRAWL_WINDOW_HOURS;
  if (!asOfDay && !inWindow) {
    return {
      service: 'firecrawl',
      status: 'skipped',
      stored: 0,
      message: 'read in the first hours after midnight',
    };
  }
  const day = asOfDay ?? previousDay(dhakaDay(now));
  const reading = await readFirecrawlCredits({
    apiKey,
    baseUrl: configured(env.FIRECRAWL_API_URL) ?? FIRECRAWL_BASE_URL,
  });
  if (reading.status !== 'ok') {
    const state: SyncState = { service: 'firecrawl', lastRunAt: now, ...describe(reading) };
    await saveState(state);
    return { service: 'firecrawl', status: state.status, stored: 0, message: state.message };
  }
  const { remaining, plan, periodStart } = reading.value;
  if (plan === null) {
    const message = 'Firecrawl did not report the plan size, so credits used cannot be worked out';
    await saveState({ service: 'firecrawl', lastRunAt: now, status: 'unreadable', message });
    return { service: 'firecrawl', status: 'unreadable', stored: 0, message };
  }
  const cumulative = plan - remaining;
  const [earlier] = await loadSpend('firecrawl', previousDay(day), previousDay(day));
  const previous =
    earlier?.cumulative === undefined
      ? null
      : { cumulative: earlier.cumulative, periodStart: earlier.periodStart ?? null };
  await saveSpend({
    service: 'firecrawl',
    period: day,
    kind: 'day',
    amount: firecrawlDayCredits(previous, { cumulative, periodStart: periodStart ?? null }),
    source: 'firecrawl_credit_usage',
    cumulative,
    periodStart: periodStart ?? null,
    fetchedAt: now,
  });
  await saveState({ service: 'firecrawl', lastRunAt: now, status: 'ok' });
  return { service: 'firecrawl', status: 'ok', stored: 1 };
}

/** Reads what each provider says it charged and stores it. Never throws; each provider reports on its own. */
export async function syncProviders(
  options: SyncOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<SyncServiceResult[]> {
  const days = Math.min(Math.max(Math.floor(options.days ?? DEFAULT_DAYS), 1), MAX_DAYS);
  const failed =
    (service: ReconcileService) =>
    (error: unknown): SyncServiceResult => {
      logger.error(`[reconcile] ${service} sync failed`, error);
      return { service, status: 'unreachable', stored: 0, message: 'sync failed' };
    };
  return Promise.all([
    syncOpenRouter(env, now, days).catch(failed('openrouter')),
    syncFirecrawl(env, now, options.firecrawlAsOfDay).catch(failed('firecrawl')),
  ]);
}

/** Hourly timer; the Firecrawl reading only happens in the first two hours of the Dhaka day, OpenRouter days are re-read idempotently. */
export function startProviderSync(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout[] {
  if (env.PROVIDER_SYNC_ENABLED === 'false') return [];
  const run = () =>
    syncProviders({}, env).catch((error) => logger.error('[reconcile] Sync run failed', error));
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const repeat = setInterval(run, REFRESH_INTERVAL_MS);
  first.unref();
  repeat.unref();
  return [first, repeat];
}
