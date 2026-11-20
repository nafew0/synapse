import type { BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AllowanceWindow, BdrenConfig, ResolvedAllowance, WindowedLimit } from './types';

const DHAKA_OFFSET_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** A window with no end (a one-time grant) is bucketed as ending far away. */
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

/** Asia/Dhaka has no daylight saving: its calendar month and Monday-based week are fixed offsets from UTC. */
export function dhakaWindows(now: Date): { month: AllowanceWindow; week: AllowanceWindow } {
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1) - DHAKA_OFFSET_MS;
  const monthEnd = Date.UTC(year, month + 1, 1) - DHAKA_OFFSET_MS;
  const dayStart = Date.UTC(year, month, local.getUTCDate());
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const weekStart = dayStart - sinceMonday * DAY_MS - DHAKA_OFFSET_MS;
  return {
    month: { start: new Date(monthStart), end: new Date(monthEnd) },
    week: { start: new Date(weekStart), end: new Date(weekStart + WEEK_MS) },
  };
}

/**
 * The ranges the meter buckets usage into. A bucket is keyed by its start, and a subscription's
 * first week starts at the same instant as its month, so the week is nudged one millisecond:
 * otherwise both windows would draw from, and charge, a single bucket.
 */
export function bucketRanges(
  month: AllowanceWindow,
  week: AllowanceWindow,
): { month: AllowanceWindow; week: AllowanceWindow } {
  if (week.start.getTime() !== month.start.getTime()) {
    return { month, week };
  }
  return { month, week: { start: new Date(week.start.getTime() + 1), end: week.end } };
}

function toWindow(raw: { start: string; end: string | null } | undefined): AllowanceWindow | null {
  if (!raw) {
    return null;
  }
  const start = new Date(raw.start);
  const end = raw.end ? new Date(raw.end) : FAR_FUTURE;
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start
    ? null
    : { start, end };
}

/** The Free allowance used when bdren.ai cannot be asked: the configured credits on the Dhaka calendar. */
export function fallbackAllowance(config: BdrenConfig, now: Date): ResolvedAllowance {
  const windows = dhakaWindows(now);
  return {
    origin: 'fallback',
    planSource: 'free',
    packageSlug: 'free',
    packageName: 'Free',
    packageVersion: null,
    institutionId: null,
    institutionName: null,
    upgradeUrl: config.upgradeUrl,
    renews: 'monthly',
    subscriptionEndsAt: null,
    etag: null,
    member: {
      month: { limit: config.fallback.monthly, window: windows.month },
      week: { limit: config.fallback.weekly, window: windows.week },
    },
    institution: null,
  };
}

/**
 * Turns bdren.ai's answer into the meter's limits and windows. Anything the meter cannot use safely
 * (no `ai_credits` limit, a limit without its window, an ended window) returns `null`, and the
 * caller falls back to Free: a missing limit is never read as unlimited.
 */
export function resolveAllowance(
  payload: BdrenAllowancePayload,
  config: BdrenConfig,
  now: Date,
): Omit<ResolvedAllowance, 'origin'> | null {
  const credits = payload.limits.ai_credits;
  if (!credits) {
    return null;
  }
  const monthLimit = credits.monthly ?? credits.lifetime;
  const monthWindow = toWindow(
    credits.monthly != null ? payload.windows.month : payload.windows.lifetime,
  );
  if (monthLimit == null || !monthWindow || monthWindow.end <= now || monthWindow.start > now) {
    return null;
  }
  const weekLimit = credits.weekly ?? null;
  const weekWindow = toWindow(payload.windows.week);
  if (weekLimit != null && (!weekWindow || weekWindow.end <= now || weekWindow.start > now)) {
    return null;
  }
  const week: WindowedLimit = {
    limit: weekLimit,
    window: weekWindow && weekWindow.end > now ? weekWindow : dhakaWindows(now).week,
  };
  const month: WindowedLimit = { limit: monthLimit, window: monthWindow };
  const seats = payload.institution?.seats ?? null;
  const ceiling =
    payload.plan_source === 'institution' && seats != null && seats > 0
      ? {
          month: { limit: monthLimit * seats, window: monthWindow },
          week: { limit: weekLimit == null ? null : weekLimit * seats, window: week.window },
        }
      : null;
  return {
    planSource: payload.plan_source,
    packageSlug: payload.package?.slug ?? 'unknown',
    packageName: payload.package?.name ?? 'Your plan',
    packageVersion: payload.package?.version ?? null,
    institutionId: payload.institution?.id ?? null,
    institutionName: payload.institution?.name ?? null,
    upgradeUrl: payload.upgrade_url || config.upgradeUrl,
    renews: payload.renews ?? null,
    subscriptionEndsAt: payload.subscription?.expires_at
      ? new Date(payload.subscription.expires_at)
      : null,
    etag: payload.etag,
    member: { month, week },
    institution: ceiling,
  };
}
