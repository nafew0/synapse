import { buildQuotaModelRows } from './quota';

import type { QuotaModelBucket } from './quota';

function bucket(scopeKey: string, overrides: Partial<QuotaModelBucket> = {}): QuotaModelBucket {
  return {
    scopeType: 'model',
    scopeKey,
    usedTokens: 0,
    reservedTokens: 0,
    limit: null,
    remaining: null,
    utilization: null,
    blocked: false,
    ...overrides,
  };
}

const sources = [
  { modelKey: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', label: 'Office Assistant' },
  { modelKey: 'gpt-5.6-luna', modelId: 'openai/gpt-5.6-luna', label: 'ChatGPT' },
  { modelKey: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', label: 'Claude' },
  {
    modelKey: 'gemini-3.1',
    modelId: 'google/gemini-3.1-flash-image',
    label: 'Image Generation',
  },
];

describe('buildQuotaModelRows', () => {
  it('lists every offered model, including ones with no usage yet', () => {
    const rows = buildQuotaModelRows({ sources, buckets: [], limits: [] });

    expect(rows.map((row) => row.label).sort()).toEqual([
      'ChatGPT',
      'Image Generation',
      'Office Assistant · Claude',
    ]);
    expect(rows.every((row) => row.status === 'active' && row.usedTokens === 0)).toBe(true);
  });

  it('joins the labels of specs that share one quota key', () => {
    const rows = buildQuotaModelRows({
      sources,
      buckets: [bucket('claude-haiku-4-5', { usedTokens: 900 })],
      limits: [],
    });

    const shared = rows.find((row) => row.modelKey === 'claude-haiku-4-5');
    expect(shared?.label).toBe('Office Assistant · Claude');
    expect(shared?.usedTokens).toBe(900);
  });

  it('names each row by the configured model id, not the engine key', () => {
    const rows = buildQuotaModelRows({ sources, buckets: [], limits: [] });

    expect(rows.find((row) => row.modelKey === 'gemini-3.1')?.modelIds).toEqual([
      'google/gemini-3.1-flash-image',
    ]);
    expect(rows.find((row) => row.modelKey === 'claude-haiku-4-5')?.modelIds).toEqual([
      'claude-haiku-4-5',
    ]);
  });

  it('lists every distinct model id that falls into one catch-all key', () => {
    const rows = buildQuotaModelRows({
      sources: [
        { modelKey: 'claude-', modelId: 'claude-haiku-4.5', label: 'Office Assistant' },
        { modelKey: 'claude-', modelId: 'claude-next', label: 'Research' },
      ],
      buckets: [],
      limits: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: 'Office Assistant · Research',
      modelIds: ['claude-haiku-4.5', 'claude-next'],
    });
  });

  it('keeps usage from a model the server no longer offers, marked retired', () => {
    const rows = buildQuotaModelRows({
      sources,
      buckets: [bucket('glm-4.6v', { usedTokens: 50 })],
      limits: [],
    });

    const retired = rows.find((row) => row.modelKey === 'glm-4.6v');
    expect(retired).toMatchObject({
      status: 'retired',
      label: 'glm-4.6v',
      modelIds: [],
      usedTokens: 50,
    });
  });

  it('surfaces a limit that points at no offered or used model', () => {
    const rows = buildQuotaModelRows({
      sources,
      buckets: [],
      limits: [{ modelKey: 'typo-model', maxTokens: 1000 }],
    });

    expect(rows.find((row) => row.modelKey === 'typo-model')).toMatchObject({
      status: 'unmatched',
      limit: 1000,
      remaining: 1000,
    });
  });

  it('applies a configured limit to an offered model that has no bucket yet', () => {
    const rows = buildQuotaModelRows({
      sources,
      buckets: [],
      limits: [{ modelKey: 'gpt-5.6-luna', maxTokens: 5000 }],
    });

    expect(rows.find((row) => row.modelKey === 'gpt-5.6-luna')).toMatchObject({
      limit: 5000,
      remaining: 5000,
      utilization: 0,
      blocked: false,
    });
  });

  it('orders active models by consumption, then retired, then unmatched', () => {
    const rows = buildQuotaModelRows({
      sources,
      buckets: [
        bucket('gpt-5.6-luna', { usedTokens: 10 }),
        bucket('claude-haiku-4-5', { usedTokens: 500 }),
        bucket('glm-4.6v', { usedTokens: 9999 }),
      ],
      limits: [{ modelKey: 'typo-model', maxTokens: 1 }],
    });

    expect(rows.map((row) => row.modelKey)).toEqual([
      'claude-haiku-4-5',
      'gpt-5.6-luna',
      'gemini-3.1',
      'glm-4.6v',
      'typo-model',
    ]);
  });

  it('ignores non-model buckets', () => {
    const rows = buildQuotaModelRows({
      sources: [],
      buckets: [{ ...bucket('tenant-a'), scopeType: 'institution' }],
      limits: [],
    });

    expect(rows).toEqual([]);
  });
});
