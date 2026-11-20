import type { UnpricedReason } from '~/pricing/table';
import type { PriceBlock } from '~/types/modelPrice';
import {
  clearPriceTable,
  loadPriceTable,
  setUnpricedSink,
  getFlaggedModels,
} from '~/pricing/table';
import { createTxMethods, defaultRate, tokenValues, cacheTokenValues } from './tx';
import { matchModelName, findMatchingPattern } from './test-helpers';

const { getMultiplier, getCacheMultiplier } = createTxMethods({} as typeof import('mongoose'), {
  matchModelName,
  findMatchingPattern,
});
const per1M = (rate: number): number => rate;

const block = (extra: Partial<PriceBlock> = {}): PriceBlock => ({
  prompt: 1.5,
  completion: 7.5,
  tiers: [],
  ...extra,
});
const load = (modelId: string, price: PriceBlock, source: 'openrouter' | 'manual' = 'openrouter') =>
  loadPriceTable([{ modelId, price, source }]);

let flags: Array<[string, UnpricedReason]>;
beforeEach(() => {
  flags = [];
  setUnpricedSink((model, reason) => flags.push([model, reason]));
});
afterEach(() => {
  clearPriceTable();
  setUnpricedSink(null);
});

describe('lookup order', () => {
  it('synced price beats endpointTokenConfig and built-in tables', () => {
    load('gpt-4', block());
    expect(getMultiplier({ model: 'gpt-4', tokenType: 'prompt' })).toBe(per1M(1.5));
    expect(getMultiplier({ model: 'gpt-4', tokenType: 'completion' })).toBe(7.5);
    expect(
      getMultiplier({
        model: 'gpt-4',
        tokenType: 'prompt',
        endpointTokenConfig: { 'gpt-4': { prompt: 99, completion: 99 } },
      }),
    ).toBe(1.5);
    expect(flags).toEqual([]);
  });

  it('a manual-source entry is used as loaded (override beats synced is store-level)', () => {
    load('gpt-4', block({ prompt: 11 }), 'manual');
    expect(getMultiplier({ model: 'gpt-4', tokenType: 'prompt' })).toBe(11);
  });

  it('a model without an entry falls to the built-in tables and is flagged fallback once', () => {
    load('other/model', block());
    const expected = tokenValues['claude-haiku-5.5'].prompt;
    expect(getMultiplier({ model: 'claude-haiku-5.5', tokenType: 'prompt' })).toBe(expected);
    getMultiplier({ model: 'claude-haiku-5.5', tokenType: 'completion' });
    expect(flags).toEqual([['claude-haiku-5.5', 'fallback']]);
  });

  it('P1 haiku-5.5 premium tier still applies from the built-in tables', () => {
    load('other/model', block());
    expect(
      getMultiplier({ model: 'claude-haiku-5.5', tokenType: 'prompt', inputTokenCount: 100001 }),
    ).toBe(0.5);
    expect(
      getMultiplier({ model: 'claude-haiku-5.5', tokenType: 'prompt', inputTokenCount: 100000 }),
    ).toBe(0.1);
  });

  it('no fallback flag while no table is loaded', () => {
    getMultiplier({ model: 'claude-haiku-5.5', tokenType: 'prompt' });
    expect(flags).toEqual([]);
  });

  it('endpointTokenConfig models fall back when not in the table, flagged once', () => {
    load('other/model', block());
    const rate = getMultiplier({
      model: 'custom-x',
      tokenType: 'prompt',
      endpointTokenConfig: { 'custom-x': { prompt: 2, completion: 3 } },
    });
    expect(rate).toBe(2);
    expect(flags).toEqual([['custom-x', 'fallback']]);
  });
});

describe('unknown models', () => {
  it('bill at max(defaultRate, highestRate) and are flagged unknown', () => {
    load(
      'big/model',
      block({
        prompt: 40,
        completion: 80,
        tiers: [{ minPromptTokens: 1, prompt: 50, completion: 90 }],
      }),
    );
    expect(getMultiplier({ model: 'zzz-no-such-model-123', tokenType: 'prompt' })).toBe(50);
    expect(getMultiplier({ model: 'zzz-no-such-model-123', tokenType: 'completion' })).toBe(90);
    expect(flags).toEqual([['zzz-no-such-model-123', 'unknown']]);
  });

  it('highest rate below defaultRate keeps defaultRate', () => {
    load('cheap/model', block());
    expect(getMultiplier({ model: 'zzz-no-such-model-123', tokenType: 'prompt' })).toBe(
      defaultRate,
    );
  });

  it('with an empty table stays defaultRate', () => {
    expect(getMultiplier({ model: 'zzz-no-such-model-123', tokenType: 'completion' })).toBe(
      defaultRate,
    );
    expect(getFlaggedModels()).toEqual([{ model: 'zzz-no-such-model-123', reason: 'unknown' }]);
  });
});

describe('tiers', () => {
  const tiered = block({
    cacheRead: 0.15,
    cacheWrite: 1.875,
    tiers: [{ minPromptTokens: 200000, prompt: 3, completion: 11, cacheRead: 0.4 }],
  });

  it('threshold is inclusive and uses the whole-prompt count', () => {
    load('t/m', tiered);
    expect(getMultiplier({ model: 't/m', tokenType: 'prompt', inputTokenCount: 199999 })).toBe(1.5);
    expect(getMultiplier({ model: 't/m', tokenType: 'prompt', inputTokenCount: 200000 })).toBe(3);
    expect(getMultiplier({ model: 't/m', tokenType: 'completion', inputTokenCount: 200000 })).toBe(
      11,
    );
    expect(getMultiplier({ model: 't/m', tokenType: 'prompt' })).toBe(1.5);
  });

  it('cache rates: tier value, scaled base, and base below the tier', () => {
    load('t/m', tiered);
    expect(getCacheMultiplier({ model: 't/m', cacheType: 'read', inputTokenCount: 200000 })).toBe(
      0.4,
    );
    expect(
      getCacheMultiplier({ model: 't/m', cacheType: 'write', inputTokenCount: 200000 }),
    ).toBeCloseTo(3.75);
    expect(getCacheMultiplier({ model: 't/m', cacheType: 'read', inputTokenCount: 1000 })).toBe(
      0.15,
    );
    expect(getCacheMultiplier({ model: 't/m', cacheType: 'write' })).toBe(1.875);
  });

  it('returns null when the priced model has no cache price', () => {
    load('t/n', block());
    expect(getCacheMultiplier({ model: 't/n', cacheType: 'read' })).toBeNull();
    expect(getCacheMultiplier({ model: 't/n', cacheType: 'write' })).toBeNull();
  });
});

describe('aliases and suffixes', () => {
  it('resolves aliases and :nitro', () => {
    loadPriceTable([
      {
        modelId: 'vendor/model',
        aliases: ['vendor/model-20260101'],
        price: block({ prompt: 4 }),
        source: 'openrouter',
      },
    ]);
    expect(getMultiplier({ model: 'vendor/model-20260101', tokenType: 'prompt' })).toBe(4);
    expect(getMultiplier({ model: 'vendor/model:nitro', tokenType: 'prompt' })).toBe(4);
    expect(flags).toEqual([]);
  });
});

describe('built-in cache table without a price entry', () => {
  it('still answers cache multipliers', () => {
    load('other/model', block());
    expect(getCacheMultiplier({ model: 'claude-haiku-5.5', cacheType: 'read' })).toBe(
      cacheTokenValues['claude-haiku-5.5'].read,
    );
  });
});
