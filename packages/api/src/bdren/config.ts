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
  return {
    enabled: env.BDREN_ALLOWANCE_ENABLED === 'true' && !!baseUrl && !!productKey && !!issuer,
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
