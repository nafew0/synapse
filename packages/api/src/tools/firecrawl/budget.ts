export type FirecrawlCall = 'search' | 'scrape';

export interface FirecrawlLimits {
  maxSearches: number;
  maxScrapes: number;
}

type FirecrawlUsage = Record<FirecrawlCall, number>;

/** Usage per request object, so every tool call and handoff in one user turn shares a budget. */
const usageByScope = new WeakMap<object, FirecrawlUsage>();

const getUsage = (scope: object): FirecrawlUsage => {
  const existing = usageByScope.get(scope);
  if (existing) {
    return existing;
  }
  const usage: FirecrawlUsage = { search: 0, scrape: 0 };
  usageByScope.set(scope, usage);
  return usage;
};

const limitFor = (limits: FirecrawlLimits, call: FirecrawlCall): number =>
  call === 'search' ? limits.maxSearches : limits.maxScrapes;

/**
 * Reserves one call against the scope's budget. Returns the refusal message for the model when
 * the budget is spent, or `null` when the call may proceed.
 */
export function reserveFirecrawlCall(
  scope: object,
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
