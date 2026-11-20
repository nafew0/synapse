import type { ProviderConfig } from '~/admin/alerts/providers';
import type { ProviderReading } from '~/admin/alerts/types';
import { readEndpoint } from '~/admin/alerts/providers';

interface ActivityItem {
  model?: string;
  usage?: number;
  requests?: number;
}

export interface OpenRouterDay {
  usd: number;
  requests: number;
  byModel: Array<{ model: string; usd: number; requests: number }>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * One UTC day of account activity. Needs a management key (any other key gets 403, reported as
 * `unreadable`). `usage` is what OpenRouter charged in USD, before the top-up fee.
 */
export const readOpenRouterActivity = (
  config: ProviderConfig,
  day: string,
): Promise<ProviderReading<OpenRouterDay>> =>
  readEndpoint<OpenRouterDay>(config, `/activity?date=${encodeURIComponent(day)}`, (body) => {
    const items = (body as { data?: unknown }).data;
    if (!Array.isArray(items)) return null;
    const perModel = new Map<string, { usd: number; requests: number }>();
    for (const item of items as ActivityItem[]) {
      const key = item.model ?? 'unknown';
      const current = perModel.get(key) ?? { usd: 0, requests: 0 };
      perModel.set(key, {
        usd: current.usd + (isNumber(item.usage) ? item.usage : 0),
        requests: current.requests + (isNumber(item.requests) ? item.requests : 0),
      });
    }
    const byModel = [...perModel.entries()]
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.usd - a.usd);
    return {
      usd: byModel.reduce((sum, item) => sum + item.usd, 0),
      requests: byModel.reduce((sum, item) => sum + item.requests, 0),
      byModel,
    };
  });
