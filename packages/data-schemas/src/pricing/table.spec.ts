import type { PriceBlock } from '~/types/modelPrice';
import type { UnpricedReason } from './table';
import {
  tierFor,
  ratesFor,
  findPrice,
  highestRate,
  flagUnpriced,
  loadPriceTable,
  clearPriceTable,
  setUnpricedSink,
  getFlaggedModels,
  normalizeModelId,
  setPriceExemptions,
  isPriceTableLoaded,
  getPriceTableLoadedAt,
} from './table';

const tiered: PriceBlock = {
  prompt: 1,
  completion: 2,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  tiers: [
    { minPromptTokens: 200000, prompt: 4, completion: 8 },
    { minPromptTokens: 100000, prompt: 2, completion: 4, cacheRead: 0.7 },
  ],
};

afterEach(() => {
  clearPriceTable();
  setUnpricedSink(null);
  setPriceExemptions([]);
});

describe('normalizeModelId', () => {
  it('lowercases, trims and drops the routing suffix', () => {
    expect(normalizeModelId('  Anthropic/Claude-X:Nitro ')).toBe('anthropic/claude-x');
    expect(normalizeModelId('a/b:floor')).toBe('a/b');
    expect(normalizeModelId('a/b:free')).toBe('a/b:free');
    expect(normalizeModelId('a/b:thinking')).toBe('a/b:thinking');
  });
});

describe('loadPriceTable / findPrice', () => {
  it('finds by modelId, alias and with a :nitro suffix', () => {
    loadPriceTable(
      [
        {
          modelId: 'Vendor/Model-1',
          aliases: ['vendor/model-1-20260101'],
          price: { prompt: 1, completion: 2, tiers: [] },
          source: 'openrouter',
        },
      ],
      new Date('2026-01-01'),
    );
    expect(findPrice('vendor/model-1')?.modelId).toBe('Vendor/Model-1');
    expect(findPrice('vendor/model-1-20260101')?.modelId).toBe('Vendor/Model-1');
    expect(findPrice('vendor/model-1:nitro')?.modelId).toBe('Vendor/Model-1');
    expect(findPrice('other')).toBeUndefined();
    expect(findPrice(undefined)).toBeUndefined();
    expect(getPriceTableLoadedAt()?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('an alias never shadows a real model id', () => {
    loadPriceTable([
      { modelId: 'a', price: { prompt: 1, completion: 1, tiers: [] }, source: 'openrouter' },
      {
        modelId: 'b',
        aliases: ['a'],
        price: { prompt: 9, completion: 9, tiers: [] },
        source: 'openrouter',
      },
    ]);
    expect(findPrice('a')?.price.prompt).toBe(1);
  });

  it('clearPriceTable empties it', () => {
    loadPriceTable([
      { modelId: 'a', price: { prompt: 1, completion: 1, tiers: [] }, source: 'openrouter' },
    ]);
    expect(isPriceTableLoaded()).toBe(true);
    clearPriceTable();
    expect(isPriceTableLoaded()).toBe(false);
    expect(getPriceTableLoadedAt()).toBeNull();
  });
});

describe('tiers', () => {
  it('uses base rates below the lowest threshold or without a count', () => {
    expect(tierFor(tiered, 99999)).toBeUndefined();
    expect(tierFor(tiered, null)).toBeUndefined();
    expect(ratesFor(tiered, 10)).toEqual({
      prompt: 1,
      completion: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it('threshold is inclusive and the highest reached tier wins', () => {
    expect(tierFor(tiered, 100000)?.minPromptTokens).toBe(100000);
    expect(tierFor(tiered, 199999)?.minPromptTokens).toBe(100000);
    expect(tierFor(tiered, 200000)?.minPromptTokens).toBe(200000);
    expect(ratesFor(tiered, 100000).prompt).toBe(2);
  });

  it('uses tier cache rate when given, else scales the base by the prompt ratio', () => {
    const mid = ratesFor(tiered, 150000);
    expect(mid.cacheRead).toBe(0.7);
    expect(mid.cacheWrite).toBeCloseTo(2.5);
    const top = ratesFor(tiered, 250000);
    expect(top.cacheRead).toBeCloseTo(0.4);
    expect(top.cacheWrite).toBeCloseTo(5);
  });

  it('keeps cache rates undefined when the base has none', () => {
    const rates = ratesFor(
      { prompt: 1, completion: 2, tiers: [{ minPromptTokens: 10, prompt: 2, completion: 4 }] },
      10,
    );
    expect(rates.cacheRead).toBeUndefined();
    expect(rates.cacheWrite).toBeUndefined();
  });

  it('highestRate scans base and tiers; 0 when empty', () => {
    expect(highestRate('prompt')).toBe(0);
    loadPriceTable([{ modelId: 'a', price: tiered, source: 'openrouter' }]);
    expect(highestRate('prompt')).toBe(4);
    expect(highestRate('completion')).toBe(8);
  });
});

describe('flagUnpriced', () => {
  const capture = (): Array<[string, UnpricedReason]> => {
    const calls: Array<[string, UnpricedReason]> = [];
    setUnpricedSink((model, reason) => calls.push([model, reason]));
    return calls;
  };

  it('flags each model/reason once', () => {
    const calls = capture();
    flagUnpriced('x/y', 'unknown');
    flagUnpriced('x/y:nitro', 'unknown');
    expect(calls).toEqual([['x/y', 'unknown']]);
    expect(getFlaggedModels()).toEqual([{ model: 'x/y', reason: 'unknown' }]);
  });

  it('fallback does not re-flag a model already flagged, but unknown upgrades a fallback', () => {
    const calls = capture();
    flagUnpriced('m', 'fallback');
    flagUnpriced('m', 'fallback');
    flagUnpriced('m', 'unknown');
    flagUnpriced('m', 'fallback');
    expect(calls).toEqual([
      ['m', 'fallback'],
      ['m', 'unknown'],
    ]);
  });

  it('ignores empty models and exempt models', () => {
    const calls = capture();
    flagUnpriced(undefined, 'unknown');
    setPriceExemptions(['Free/Model:nitro']);
    flagUnpriced('free/model', 'unknown');
    expect(calls).toEqual([]);
  });

  it('a throwing sink does not propagate', () => {
    setUnpricedSink(() => {
      throw new Error('boom');
    });
    expect(() => flagUnpriced('q', 'unknown')).not.toThrow();
  });
});
