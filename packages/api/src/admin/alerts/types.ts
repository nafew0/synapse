export type AlertSeverity = 'critical' | 'warning';

export type AlertKind =
  | 'openrouter_key'
  | 'openrouter_expiry'
  | 'openrouter_balance'
  | 'firecrawl_key'
  | 'firecrawl_credits'
  | 'spend_spike';

export interface AlertFinding {
  /** Stable identity of the condition, so a repeat check updates one alert instead of adding another. */
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
}

/** What one check looked at: the findings it raised and the kinds it could actually evaluate. */
export interface CheckOutcome {
  /** A kind listed here and absent from `findings` is healthy, so its open alerts resolve. */
  kinds: AlertKind[];
  findings: AlertFinding[];
}

export interface PlatformAlertRecord {
  _id: string;
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  status: 'open' | 'resolved';
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt?: Date | null;
  seenAt?: Date | null;
  seenBy?: string | null;
}

export type ProviderReading<T> =
  | { status: 'ok'; value: T }
  | { status: 'rejected'; httpStatus: number; message: string }
  | { status: 'unreadable'; httpStatus: number }
  | { status: 'unreachable'; message: string };

export interface OpenRouterKeyInfo {
  /** USD cap on the key, null when the key has none. */
  limit: number | null;
  limitRemaining: number | null;
  expiresAt: string | null;
}

export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
}

export interface FirecrawlCredits {
  remaining: number;
  /** Credits in the plan; null when the account endpoint does not say. */
  plan: number | null;
}

export interface SpendRow {
  scope: 'institution' | 'user';
  id: string;
  /** Calendar day in the rollup timezone, `YYYY-MM-DD`. */
  day: string;
  usd: number;
}

export interface AlertThresholds {
  /** Raise a balance alert when the money left covers fewer days than this at the recent daily spend. */
  balanceDays: number;
  /** Raise a balance alert when less than this share of a key limit or plan is left. */
  lowShare: number;
  expiryDays: number;
  spikeMultiplier: number;
  /** A day below this is never a spike, so a quiet account's first dollars do not alert. */
  spikeMinUsd: number;
  spikeAbsoluteUsd: number;
  spikeWindowDays: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  balanceDays: 3,
  lowShare: 0.2,
  expiryDays: 7,
  spikeMultiplier: 3,
  spikeMinUsd: 5,
  spikeAbsoluteUsd: 100,
  spikeWindowDays: 14,
};
