export type ReconcileService = 'openrouter' | 'firecrawl' | 'unstructured';
export type ReconcileUnit = 'usd' | 'credits';
export type GapStatus = 'ok' | 'flagged' | 'missing_provider' | 'missing_ledger' | 'empty';

/** One comparison of what the ledger recorded with what the provider reported. */
export interface Comparison {
  ledger: number;
  provider: number | null;
  /** `ledger - provider`; positive means we recorded more than the provider charged. */
  gap: number | null;
  /** `gap / provider`; null without a non-zero provider figure. */
  gapPct: number | null;
  status: GapStatus;
}

export interface DayFigure {
  day: string;
  ledger: number;
  /** Null when the provider data for this day is missing. */
  provider: number | null;
}

export interface PeriodRow extends Comparison {
  period: string;
  /** Days in the period that fall inside the requested range. */
  days: number;
  /** Days that have provider data; the comparison covers only these. */
  daysCovered: number;
  /** Ledger total for every day of the period, covered or not. */
  ledgerAll: number;
}

export interface ProviderSpendRecord {
  service: ReconcileService;
  /** `YYYY-MM-DD`, or `YYYY-MM` for a monthly entry. */
  period: string;
  kind: 'day' | 'month';
  /** USD for OpenRouter and Unstructured, credits for Firecrawl. Null when it could not be worked out. */
  amount: number | null;
  source: 'openrouter_activity' | 'firecrawl_credit_usage' | 'manual';
  requests?: number;
  pages?: number;
  /** Firecrawl: credits used so far in the billing period when the reading was taken. */
  cumulative?: number;
  periodStart?: string | null;
  byModel?: Array<{ model: string; usd: number; requests: number }>;
  note?: string;
  enteredBy?: string | null;
  fetchedAt: Date;
}

export interface SyncState {
  service: ReconcileService;
  lastRunAt: Date;
  status: 'ok' | 'not_configured' | 'rejected' | 'unreadable' | 'unreachable';
  message?: string;
  httpStatus?: number;
}
