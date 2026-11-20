import type { BdrenConfig } from './types';

const DEFAULT_UPGRADE_URL = 'https://bdren.ai/profile/billing';
/** Free at ৳30 a month and ৳135 a dollar; a stand-in until bdren.ai answers, never unlimited. */
const DEFAULT_FALLBACK_MONTHLY = 222_000;
const DEFAULT_FALLBACK_WEEKLY = 78_000;

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function secrets(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
}

/**
 * Settings of the bdren.ai link. `BDREN_PRODUCT_KEY` is the same key the task-cost endpoint checks.
 * Switched on by `BDREN_ALLOWANCE_ENABLED=true`, and only when the address, key and issuer are set.
 */
export function readBdrenConfig(env: NodeJS.ProcessEnv = process.env): BdrenConfig {
  const baseUrl = (env.BDREN_API_URL ?? '').trim().replace(/\/+$/, '');
  const productKey = (env.BDREN_PRODUCT_KEY ?? '').trim();
  const issuer = (env.BDREN_ISSUER ?? '').trim().replace(/\/+$/, '');
  const linked = !!baseUrl && !!productKey && !!issuer;
  return {
    enabled: env.BDREN_ALLOWANCE_ENABLED === 'true' && linked,
    usageExport: env.BDREN_USAGE_EXPORT_ENABLED === 'true' && linked,
    baseUrl,
    productKey,
    issuer,
    webhookSecrets: secrets(env.BDREN_WEBHOOK_SECRET),
    timeoutMs: positive(env.BDREN_ALLOWANCE_TIMEOUT_MS, 2000),
    ttlMs: positive(env.BDREN_ALLOWANCE_TTL_SECONDS, 600) * 1000,
    maxStaleMs: positive(env.BDREN_ALLOWANCE_MAX_STALE_HOURS, 24) * 3_600_000,
    upgradeUrl: (env.BDREN_UPGRADE_URL ?? '').trim() || DEFAULT_UPGRADE_URL,
    fallback: {
      monthly: positive(env.BDREN_FREE_FALLBACK_MONTHLY_CREDITS, DEFAULT_FALLBACK_MONTHLY),
      weekly: positive(env.BDREN_FREE_FALLBACK_WEEKLY_CREDITS, DEFAULT_FALLBACK_WEEKLY),
    },
  };
}

/**
 * ZITADEL scope that puts the user's own organization (`urn:zitadel:iam:user:resourceowner:*`)
 * in the ID token. bdren.ai reads the organization from the token to route institution members, so
 * with the link on Synapse asks for it too; without it the token never carries the claim.
 */
export const ZITADEL_ORGANIZATION_SCOPE = 'urn:zitadel:iam:user:resourceowner';

const DEFAULT_OPENID_SCOPE = 'openid profile email';

/** The login scope, plus the organization scope when the bdren.ai link is on and it is not already asked for. */
export function withOrganizationScope(
  scope: string | undefined,
  config: BdrenConfig,
): string | undefined {
  if (!config.enabled) {
    return scope;
  }
  const scopes = (scope?.trim() || DEFAULT_OPENID_SCOPE).split(/\s+/);
  return scopes.includes(ZITADEL_ORGANIZATION_SCOPE)
    ? scopes.join(' ')
    : [...scopes, ZITADEL_ORGANIZATION_SCOPE].join(' ');
}
