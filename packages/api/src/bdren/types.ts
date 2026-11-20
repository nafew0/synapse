import type { BdrenAllowancePayload } from '@librechat/data-schemas';

export type PlanSource = 'free' | 'personal' | 'institution';

/** Where a resolved allowance came from, so a refusal and the logs can say how fresh it is. */
export type AllowanceOrigin = 'fresh' | 'cache' | 'stale' | 'fallback';

export interface BdrenConfig {
  enabled: boolean;
  /** Whether per-member usage is sent to bdren.ai (`BDREN_USAGE_EXPORT_ENABLED`); needs the address, key and issuer. */
  usageExport: boolean;
  baseUrl: string;
  productKey: string;
  /** The OpenID issuer bdren.ai knows its users by; only users signed in through it are linked. */
  issuer: string;
  webhookSecrets: string[];
  timeoutMs: number;
  /** How long an answer is used without asking again. */
  ttlMs: number;
  /** How long the last answer is kept when bdren.ai cannot be reached. */
  maxStaleMs: number;
  upgradeUrl: string;
  /** The Free allowance used when bdren.ai cannot say, in credits (1 credit = $0.000001). */
  fallback: { monthly: number; weekly: number };
}

/** One counting window of the meter. */
export interface AllowanceWindow {
  start: Date;
  end: Date;
}

export interface WindowedLimit {
  /** `null` records usage without refusing. */
  limit: number | null;
  window: AllowanceWindow;
}

export interface ResolvedAllowance {
  origin: AllowanceOrigin;
  planSource: PlanSource;
  packageSlug: string;
  packageName: string;
  packageVersion: number | null;
  institutionId: string | null;
  institutionName: string | null;
  institutionSlug?: string | null;
  upgradeUrl: string;
  renews: string | null;
  subscriptionEndsAt: Date | null;
  etag: string | null;
  member: { month: WindowedLimit; week: WindowedLimit };
  /** Seats × the seat level's allowance; a safety ceiling only, never a pool. `null` unless a seat. */
  institution: { month: WindowedLimit; week: WindowedLimit } | null;
}

/** The person an allowance is asked for. The cache is keyed by `userId` and checked against the rest. */
export interface AllowanceSubject {
  userId: string;
  /** The quota account the user is metered under (their institution, or the individuals account). */
  account: string;
  issuer: string;
  subject: string;
  /** The raw ID token of the login in progress, passed on to bdren.ai when it does not know the person. */
  idToken?: string;
}

export type AllowanceFetch =
  | { status: 'ok'; payload: BdrenAllowancePayload }
  | { status: 'not_modified' }
  | { status: 'not_found' }
  | { status: 'error'; reason: string };
