import type {
  SpendRow,
  CheckOutcome,
  AlertFinding,
  AlertThresholds,
  FirecrawlCredits,
  OpenRouterCredits,
  OpenRouterKeyInfo,
  ProviderReading,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';

const DAY_MS = 86_400_000;
const NO_OUTCOME: CheckOutcome = { kinds: [], findings: [] };

const usd = (value: number): string => `$${value.toFixed(2)}`;

export interface OpenRouterReadings {
  key: ProviderReading<OpenRouterKeyInfo>;
  credits: ProviderReading<OpenRouterCredits>;
  /** Average daily spend over the recent window, for the days-left estimate. */
  averageDailyUsd: number;
}

type Rejected = Extract<ProviderReading<unknown>, { status: 'rejected' }>;

function keyRejected(reading: Rejected): AlertFinding {
  return {
    key: 'openrouter_key',
    kind: 'openrouter_key',
    severity: 'critical',
    title: 'OpenRouter is rejecting our API key',
    detail: `OpenRouter answered HTTP ${reading.httpStatus}: ${reading.message}. Every model call fails until the key is replaced or the account is restored.`,
  };
}

/** Money left across the key limit and the account balance, the smaller one being what stops a call. */
function remainingUsd(key: OpenRouterKeyInfo, credits?: OpenRouterCredits): number | null {
  const left: number[] = [];
  if (key.limitRemaining !== null) left.push(key.limitRemaining);
  if (credits) left.push(credits.totalCredits - credits.totalUsage);
  return left.length ? Math.min(...left) : null;
}

function balanceFinding(
  remaining: number,
  share: number | null,
  averageDailyUsd: number,
  thresholds: AlertThresholds,
): AlertFinding | null {
  const daysLeft = averageDailyUsd > 0 ? remaining / averageDailyUsd : null;
  const exhausted = remaining <= 0;
  const lowDays = daysLeft !== null && daysLeft < thresholds.balanceDays;
  const lowShare = share !== null && share < thresholds.lowShare;
  if (!exhausted && !lowDays && !lowShare) return null;
  const cover =
    daysLeft === null
      ? ''
      : ` At ${usd(averageDailyUsd)} a day that lasts about ${Math.max(daysLeft, 0).toFixed(1)} days.`;
  return {
    key: 'openrouter_balance',
    kind: 'openrouter_balance',
    severity: exhausted ? 'critical' : 'warning',
    title: exhausted ? 'OpenRouter credit is used up' : 'OpenRouter credit is running low',
    detail: `${usd(Math.max(remaining, 0))} left on the key or account.${cover}`,
  };
}

function expiryFinding(
  key: OpenRouterKeyInfo,
  now: Date,
  thresholds: AlertThresholds,
): AlertFinding | null {
  if (!key.expiresAt) return null;
  const msLeft = new Date(key.expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(msLeft) || msLeft > thresholds.expiryDays * DAY_MS) return null;
  const expired = msLeft <= 0;
  return {
    key: 'openrouter_expiry',
    kind: 'openrouter_expiry',
    severity: expired ? 'critical' : 'warning',
    title: expired ? 'The OpenRouter API key has expired' : 'The OpenRouter API key expires soon',
    detail: `The key expires ${key.expiresAt}. Create a new key before then.`,
  };
}

export function evaluateOpenRouter(
  readings: OpenRouterReadings,
  now: Date = new Date(),
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): CheckOutcome {
  const { key, credits, averageDailyUsd } = readings;
  if (key.status === 'rejected') {
    return { kinds: ['openrouter_key'], findings: [keyRejected(key)] };
  }
  if (key.status !== 'ok') return NO_OUTCOME;
  const account = credits.status === 'ok' ? credits.value : undefined;
  const remaining = remainingUsd(key.value, account);
  const { limit, limitRemaining } = key.value;
  const share = limit && limit > 0 && limitRemaining !== null ? limitRemaining / limit : null;
  const findings = [
    expiryFinding(key.value, now, thresholds),
    remaining === null ? null : balanceFinding(remaining, share, averageDailyUsd, thresholds),
  ].filter((finding): finding is AlertFinding => finding !== null);
  return { kinds: ['openrouter_key', 'openrouter_expiry', 'openrouter_balance'], findings };
}

export function evaluateFirecrawl(
  reading: ProviderReading<FirecrawlCredits>,
  configuredPlan: number | null,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): CheckOutcome {
  if (reading.status === 'rejected') {
    return {
      kinds: ['firecrawl_key'],
      findings: [
        {
          key: 'firecrawl_key',
          kind: 'firecrawl_key',
          severity: 'critical',
          title: 'Firecrawl is rejecting our API key',
          detail: `Firecrawl answered HTTP ${reading.httpStatus}: ${reading.message}. Web search and page reading fail until the key is fixed.`,
        },
      ],
    };
  }
  if (reading.status !== 'ok') return NO_OUTCOME;
  const plan = reading.value.plan ?? configuredPlan;
  const { remaining } = reading.value;
  const exhausted = remaining <= 0;
  const low = plan !== null && plan > 0 && remaining < plan * thresholds.lowShare;
  const kinds: CheckOutcome['kinds'] = ['firecrawl_key', 'firecrawl_credits'];
  if (!exhausted && !low) return { kinds, findings: [] };
  const ofPlan = plan ? ` of ${plan.toLocaleString('en-US')}` : '';
  return {
    kinds,
    findings: [
      {
        key: 'firecrawl_credits',
        kind: 'firecrawl_credits',
        severity: exhausted ? 'critical' : 'warning',
        title: exhausted ? 'Firecrawl credits are used up' : 'Firecrawl credits are running low',
        detail: `${remaining.toLocaleString('en-US')}${ofPlan} credits left. Web search and page reading stop when they run out.`,
      },
    ],
  };
}

/** Turns spend by scope and day into alerts for scopes whose latest day is out of line with their recent average. */
export function evaluateSpikes(
  rows: SpendRow[],
  today: string,
  labels: Map<string, string>,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): CheckOutcome {
  const todayUsd = new Map<string, number>();
  const priorUsd = new Map<string, number>();
  for (const row of rows) {
    const scopeKey = `${row.scope}:${row.id}`;
    const bucket = row.day === today ? todayUsd : priorUsd;
    bucket.set(scopeKey, (bucket.get(scopeKey) ?? 0) + row.usd);
  }
  const findings: AlertFinding[] = [];
  for (const [scopeKey, spent] of todayUsd) {
    const average = (priorUsd.get(scopeKey) ?? 0) / thresholds.spikeWindowDays;
    const aboveAverage = spent > average * thresholds.spikeMultiplier;
    const aboveCeiling = spent > thresholds.spikeAbsoluteUsd;
    if (spent < thresholds.spikeMinUsd || !(aboveAverage || aboveCeiling)) continue;
    const scope = scopeKey.startsWith('institution:') ? 'institution' : 'user';
    const label = labels.get(scopeKey) ?? scopeKey.slice(scope.length + 1);
    findings.push({
      key: `spike:${scopeKey}:${today}`,
      kind: 'spend_spike',
      severity: aboveCeiling ? 'critical' : 'warning',
      title: `Spend spike: ${label}`,
      detail: `${scope === 'institution' ? 'Institution' : 'User'} ${label} spent ${usd(spent)} on ${today}, against a ${thresholds.spikeWindowDays}-day average of ${usd(average)} a day.`,
    });
  }
  return { kinds: ['spend_spike'], findings };
}
