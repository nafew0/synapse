import type {
  ProviderReading,
  OpenRouterKeyInfo,
  OpenRouterCredits,
  FirecrawlCredits,
} from './types';

const TIMEOUT_MS = 10_000;
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
}

interface OpenRouterKeyBody {
  data?: { limit?: number | null; limit_remaining?: number | null; expires_at?: string | null };
}

interface OpenRouterCreditsBody {
  data?: { total_credits?: number; total_usage?: number };
}

interface FirecrawlBody {
  data?: {
    remaining_credits?: number;
    remainingCredits?: number;
    plan_credits?: number;
    planCredits?: number;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
  };
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Pulls the provider's own message out of an error body, which both providers send as `{error:{message}}` or `{error:"…"}`. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    const error = body.error;
    const message = typeof error === 'string' ? error : error?.message;
    return message?.slice(0, 200) || response.statusText || 'no message';
  } catch {
    return response.statusText || 'no message';
  }
}

/** A free read of a provider's account endpoint. 401 and 402 mean the key is refused; other failures say nothing about it. */
export async function readEndpoint<T>(
  config: ProviderConfig,
  path: string,
  parse: (body: unknown) => T | null,
): Promise<ProviderReading<T>> {
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 402) {
      return {
        status: 'rejected',
        httpStatus: response.status,
        message: await errorMessage(response),
      };
    }
    if (!response.ok) return { status: 'unreadable', httpStatus: response.status };
    const value = parse(await response.json());
    return value === null
      ? { status: 'unreadable', httpStatus: response.status }
      : { status: 'ok', value };
  } catch (error) {
    return {
      status: 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const readOpenRouterKey = (config: ProviderConfig) =>
  readEndpoint<OpenRouterKeyInfo>(config, '/key', (body) => {
    const data = (body as OpenRouterKeyBody).data;
    if (!data) return null;
    return {
      limit: isNumber(data.limit) ? data.limit : null,
      limitRemaining: isNumber(data.limit_remaining) ? data.limit_remaining : null,
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    };
  });

/** Only management keys can read the account balance; any other key gets a 403, reported as unreadable. */
export const readOpenRouterCredits = (config: ProviderConfig) =>
  readEndpoint<OpenRouterCredits>(config, '/credits', (body) => {
    const data = (body as OpenRouterCreditsBody).data;
    if (!data || !isNumber(data.total_credits) || !isNumber(data.total_usage)) return null;
    return { totalCredits: data.total_credits, totalUsage: data.total_usage };
  });

export const readFirecrawlCredits = (config: ProviderConfig) =>
  readEndpoint<FirecrawlCredits>(config, '/v2/team/credit-usage', (body) => {
    const data = (body as FirecrawlBody).data;
    const remaining = data?.remainingCredits ?? data?.remaining_credits;
    if (!isNumber(remaining)) return null;
    const plan = data?.planCredits ?? data?.plan_credits;
    return {
      remaining,
      plan: isNumber(plan) ? plan : null,
      periodStart: typeof data?.billingPeriodStart === 'string' ? data.billingPeriodStart : null,
    };
  });
