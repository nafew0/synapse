import type {
  IUsagePackage,
  UsagePricingFields,
  MemberUsagePackage,
  InstitutionUsagePackage,
} from '@librechat/data-schemas';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { PricingFns } from '~/agents/transactions';
import type { EndpointTokenConfig } from '~/types/tokens';
import { computeUsageCostUSD } from '~/agents/usage';
import { CREDITS_PER_USD, priceUsagePackage } from './packages';
import { isImageModel, unitFor } from './weights';

/** Credit scopes. Kept apart from the token scopes so a tenant's token buckets never mix with credits. */
export type CreditScopeType = 'institution_credits' | 'member_credits';
export type QuotaWindow = 'month' | 'week';

/** Monthly and weekly allowance in credits; `null` records usage without ever refusing. */
export interface WindowLimits {
  month: number | null;
  week: number | null;
}

export interface CreditLimits {
  institution: WindowLimits;
  member: WindowLimits;
  institutionPackageKey: string | null;
  memberPackageKey: string | null;
  /** The member's package is shown to them as "Unlimited". Its ceiling is still enforced. */
  unlimited: boolean;
}

/** Packages keyed by `key`, with the pricing that converts their taka allowance to credits. */
export interface UsageCatalogSnapshot {
  packages: Map<string, IUsagePackage>;
  pricing: UsagePricingFields;
}

export interface CreditRates {
  /** Credits per input token (equal to USD per 1M tokens). */
  input: number;
  /** Credits per output token. */
  output: number;
}

const NO_LIMITS: WindowLimits = { month: null, week: null };

/**
 * Credits per token for one model. A rate in USD per 1M tokens is also the cost in credits
 * (USD × 1e6) of one token, so the rates from the billing table are used unchanged.
 */
export function creditRates({
  model,
  endpoint,
  endpointTokenConfig,
  pricing,
}: {
  model?: string;
  endpoint?: string;
  endpointTokenConfig?: EndpointTokenConfig;
  pricing: Pick<PricingFns, 'getMultiplier'>;
}): CreditRates {
  const params = { model, endpoint, endpointTokenConfig };
  return {
    input: Math.max(pricing.getMultiplier({ ...params, tokenType: 'prompt' }), 0),
    output: Math.max(pricing.getMultiplier({ ...params, tokenType: 'completion' }), 0),
  };
}

export function estimateCredits(
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  rates: CreditRates,
): number {
  return Math.ceil(
    Math.max(inputTokens, 0) * rates.input + Math.max(outputTokens, 0) * rates.output,
  );
}

/**
 * The largest output that still fits in `remainingCredits` after the input is paid for, so an
 * over-long request is trimmed instead of refused. `Infinity` when output is free.
 */
export function outputTokensForCredits(
  remainingCredits: number,
  inputCredits: number,
  outputRate: number,
): number {
  if (outputRate <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(Math.floor((remainingCredits - inputCredits) / outputRate), 0);
}

/**
 * Actual credits of a finished run: every model call priced at its own model and endpoint
 * config with the functions that write `Transaction`, so the meter matches the cost ledger.
 */
export function creditsForUsage(
  usages: ReadonlyArray<UsageMetadata | null | undefined> | undefined,
  pricing: PricingFns,
  resolveTokenConfig?: (usage: UsageMetadata) => EndpointTokenConfig | undefined,
): number {
  let usd = 0;
  for (const usage of usages ?? []) {
    if (usage == null) {
      continue;
    }
    usd += computeUsageCostUSD(usage, pricing, resolveTokenConfig?.(usage));
  }
  return Math.round(usd * CREDITS_PER_USD);
}

/** Whether a request is metered in credits: true once its institution or member has a package. */
export function usesCredits(
  institutionPackage?: InstitutionUsagePackage | null,
  memberPackage?: MemberUsagePackage | null,
): boolean {
  return Boolean(
    institutionPackage?.packageKey ||
      institutionPackage?.memberPackageKey ||
      memberPackage?.packageKey,
  );
}

function activeMemberPackageKey(
  memberPackage: MemberUsagePackage | null | undefined,
  now: Date,
): string | null {
  if (!memberPackage?.packageKey) {
    return null;
  }
  const expiresAt = memberPackage.expiresAt ? new Date(memberPackage.expiresAt) : null;
  return expiresAt != null && expiresAt <= now ? null : memberPackage.packageKey;
}

function packageLimits(
  key: string | null,
  catalog: UsageCatalogSnapshot,
): { limits: WindowLimits; pkg: IUsagePackage | null } {
  const pkg = key ? (catalog.packages.get(key) ?? null) : null;
  if (!pkg) {
    return { limits: NO_LIMITS, pkg: null };
  }
  const priced = priceUsagePackage(pkg, catalog.pricing);
  return { limits: { month: priced.monthlyCredits, week: priced.weeklyCredits }, pkg };
}

/**
 * Limits for one request. A member's own unexpired package overrides the institution default.
 * An archived package still applies to whoever is on it; a key with no package is unlimited.
 */
export function resolveCreditLimits({
  institutionPackage,
  memberPackage,
  catalog,
  now = new Date(),
}: {
  institutionPackage?: InstitutionUsagePackage | null;
  memberPackage?: MemberUsagePackage | null;
  catalog: UsageCatalogSnapshot;
  now?: Date;
}): CreditLimits {
  const institutionPackageKey = institutionPackage?.packageKey ?? null;
  const memberPackageKey =
    activeMemberPackageKey(memberPackage, now) ?? institutionPackage?.memberPackageKey ?? null;
  const institution = packageLimits(institutionPackageKey, catalog);
  const member = packageLimits(memberPackageKey, catalog);
  return {
    institution: institution.limits,
    member: member.limits,
    institutionPackageKey: institution.pkg ? institutionPackageKey : null,
    memberPackageKey: member.pkg ? memberPackageKey : null,
    unlimited: member.pkg?.unlimited === true,
  };
}

/** The refusal code a credit scope reports, so the UI names which allowance ran out. */
/** Some allowance is left, but not enough for one whole image. */
export const IMAGE_CREDITS_LOW = 'IMAGE_CREDITS_LOW';

/** The limit code of a credit refusal; `imageShortfall` marks an image refused while allowance remains. */
export function creditLimitCode(
  scopeType: CreditScopeType,
  window: QuotaWindow,
  imageShortfall = false,
): string {
  if (imageShortfall) {
    return IMAGE_CREDITS_LOW;
  }
  if (scopeType === 'member_credits') {
    return window === 'week' ? 'WEEKLY_CAP' : 'MONTHLY_CAP';
  }
  return window === 'week' ? 'INSTITUTION_WEEKLY_CAP' : 'INSTITUTION_CAP';
}

/** Output tokens of one generated 1K image on the Gemini image models (measured; see librechat.yaml). */
export const IMAGE_OUTPUT_TOKENS_ESTIMATE = 1120;
/** A generous prompt for one image request. */
const IMAGE_INPUT_TOKENS_ESTIMATE = 500;

/** Credits one generated image costs at an image model's rates. */
export function imageCreditsEstimate(rates: CreditRates): number {
  return estimateCredits(
    { inputTokens: IMAGE_INPUT_TOKENS_ESTIMATE, outputTokens: IMAGE_OUTPUT_TOKENS_ESTIMATE },
    rates,
  );
}

/** A graph edge, as far as routing to an agent goes. */
export interface RoutableEdge {
  from: string | string[];
  to: string | string[];
  [key: string]: unknown;
}

/** The edges with the given agents removed as destinations; an edge left with none is dropped. */
export function withoutEdgeTargets<T extends RoutableEdge>(
  edges: ReadonlyArray<T> | undefined,
  removed: ReadonlySet<string>,
): T[] {
  return (edges ?? []).flatMap((edge) => {
    const targets = (Array.isArray(edge.to) ? edge.to : [edge.to]).filter((id) => !removed.has(id));
    if (targets.length === 0) {
      return [];
    }
    return [{ ...edge, to: Array.isArray(edge.to) ? targets : targets[0] }];
  });
}

/** The parts of an agent that say whether it generates images. */
export interface ImageAgentLike {
  model?: string | null;
  provider?: string | null;
  model_parameters?: { model?: string | null } | null;
}

/** Image agents whose single image would cost more than `remainingCredits`. */
export function unaffordableImageAgents<A extends ImageAgentLike>(
  agents: ReadonlyMap<string, A>,
  remainingCredits: number,
  imageCredits: (id: string, agent: A, model: string | undefined) => number,
): Set<string> {
  const unaffordable = new Set<string>();
  for (const [id, agent] of agents) {
    const model = agent?.model ?? agent?.model_parameters?.model ?? undefined;
    if (!isImageModel(model) && unitFor(agent?.provider) !== 'images') {
      continue;
    }
    if (imageCredits(id, agent, model) > remainingCredits) {
      unaffordable.add(id);
    }
  }
  return unaffordable;
}
