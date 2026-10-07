export type FirecrawlCall = 'search' | 'scrape';

export interface FirecrawlLimits {
  maxSearches: number;
  maxScrapes: number;
}

/**
 * A generation key (`user:stream:jobCreatedAt`) when the run belongs to a resumable job, so a
 * turn paused by ask_user_question keeps its budget when it resumes; otherwise the request object.
 */
export type FirecrawlBudgetScope = string | object;

type FirecrawlUsage = Record<FirecrawlCall, number>;

interface KeyedUsage {
  usage: FirecrawlUsage;
  expiresAt: number;
}

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_THRESHOLD = 500;

const usageByRequest = new WeakMap<object, FirecrawlUsage>();
const usageByKey = new Map<string, KeyedUsage>();

const emptyUsage = (): FirecrawlUsage => ({ search: 0, scrape: 0 });

const pruneExpired = (now: number): void => {
  for (const [key, entry] of usageByKey) {
    if (entry.expiresAt <= now) {
      usageByKey.delete(key);
    }
  }
};

const getKeyedUsage = (key: string, now: number): FirecrawlUsage => {
  const existing = usageByKey.get(key);
  if (existing && existing.expiresAt > now) {
    existing.expiresAt = now + KEY_TTL_MS;
    return existing.usage;
  }
  if (usageByKey.size >= PRUNE_THRESHOLD) {
    pruneExpired(now);
  }
  const usage = emptyUsage();
  usageByKey.set(key, { usage, expiresAt: now + KEY_TTL_MS });
  return usage;
};

const getRequestUsage = (scope: object): FirecrawlUsage => {
  const existing = usageByRequest.get(scope);
  if (existing) {
    return existing;
  }
  const usage = emptyUsage();
  usageByRequest.set(scope, usage);
  return usage;
};

const getUsage = (scope: FirecrawlBudgetScope): FirecrawlUsage =>
  typeof scope === 'string' ? getKeyedUsage(scope, Date.now()) : getRequestUsage(scope);

/** Picks the budget scope for a run: its generation job when it has one, else the request. */
export function resolveFirecrawlBudgetScope({
  req,
  userId,
  streamId,
  jobCreatedAt,
}: {
  req?: object;
  userId?: string;
  streamId?: string | null;
  jobCreatedAt?: number;
}): FirecrawlBudgetScope {
  if (userId && streamId && jobCreatedAt != null) {
    return `${userId}:${streamId}:${jobCreatedAt}`;
  }
  return req ?? {};
}

const limitFor = (limits: FirecrawlLimits, call: FirecrawlCall): number =>
  call === 'search' ? limits.maxSearches : limits.maxScrapes;

/**
 * Reserves one call against the scope's budget. Returns the refusal message for the model when
 * the budget is spent, or `null` when the call may proceed.
 */
export function reserveFirecrawlCall(
  scope: FirecrawlBudgetScope,
  call: FirecrawlCall,
  limits: FirecrawlLimits,
): string | null {
  const usage = getUsage(scope);
  const limit = limitFor(limits, call);
  if (usage[call] >= limit) {
    const tool = call === 'search' ? 'firecrawl_search' : 'firecrawl_scrape';
    return `Budget reached: ${tool} has been used ${limit} of ${limit} times for this request. Do not call it again; continue with the sources you already have and say which parts could not be checked.`;
  }
  usage[call] += 1;
  return null;
}
