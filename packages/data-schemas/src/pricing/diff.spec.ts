import type { PriceBlock } from '~/types/modelPrice';
import { diffPrices, changedLines, samePrice, summarizeDiff, formatPercent } from './diff';

const base: PriceBlock = {
  prompt: 3,
  completion: 15,
  cacheRead: 0.3,
  tiers: [{ minPromptTokens: 200000, prompt: 6, completion: 22.5 }],
};

const find = (lines: ReturnType<typeof diffPrices>, field: string) =>
  lines.find((line) => line.field === field);

describe('diffPrices', () => {
  it('marks every present field added for a first price', () => {
    const lines = diffPrices(null, base);
    expect(find(lines, 'prompt')?.kind).toBe('added');
    expect(find(lines, 'cacheRead')?.kind).toBe('added');
    expect(find(lines, 'tier:200000:prompt')?.kind).toBe('added');
    expect(find(lines, 'cacheWrite')).toBeUndefined();
  });

  it('reports changed with change and pct', () => {
    const lines = diffPrices(base, { ...base, completion: 16.5 });
    const completion = find(lines, 'completion');
    expect(completion).toMatchObject({
      kind: 'changed',
      previous: 15,
      current: 16.5,
      change: 1.5,
      changePct: 10,
    });
    expect(find(lines, 'prompt')?.kind).toBe('unchanged');
  });

  it('pct is null when the previous value was 0', () => {
    const lines = diffPrices({ ...base, cacheRead: 0 }, base);
    expect(find(lines, 'cacheRead')).toMatchObject({ kind: 'changed', changePct: null });
  });

  it('reports added and removed base fields', () => {
    const lines = diffPrices(base, { ...base, cacheRead: undefined, cacheWrite: 3.75 });
    expect(find(lines, 'cacheRead')).toMatchObject({ kind: 'removed', current: null });
    expect(find(lines, 'cacheWrite')).toMatchObject({ kind: 'added', previous: null });
  });

  it('diffs tiers by threshold: changed, added, removed', () => {
    const next: PriceBlock = {
      ...base,
      tiers: [{ minPromptTokens: 100000, prompt: 4, completion: 18 }],
    };
    const lines = diffPrices(base, next);
    expect(find(lines, 'tier:100000:prompt')?.kind).toBe('added');
    expect(find(lines, 'tier:200000:prompt')?.kind).toBe('removed');
    const changed = diffPrices(base, {
      ...base,
      tiers: [{ minPromptTokens: 200000, prompt: 7, completion: 22.5 }],
    });
    expect(find(changed, 'tier:200000:prompt')).toMatchObject({ kind: 'changed', change: 1 });
    expect(find(changed, 'tier:200000:completion')?.kind).toBe('unchanged');
  });

  it('rounds floating point noise', () => {
    const lines = diffPrices({ ...base, prompt: 0.1 }, { ...base, prompt: 0.3 });
    expect(find(lines, 'prompt')?.change).toBe(0.2);
  });
});

describe('samePrice / changedLines', () => {
  it('identical blocks are the same, any change is not', () => {
    expect(samePrice(base, { ...base, tiers: [...base.tiers] })).toBe(true);
    expect(samePrice(base, { ...base, prompt: 3.1 })).toBe(false);
    expect(samePrice(base, { ...base, tiers: [] })).toBe(false);
    expect(changedLines(diffPrices(base, base))).toEqual([]);
  });
});

describe('summarizeDiff', () => {
  it('describes the first change and counts the rest', () => {
    const lines = diffPrices(base, { ...base, completion: 16.5, prompt: 3.3 });
    expect(summarizeDiff('m/x', lines)).toBe('m/x: input $3 → $3.3 per 1M (+10%) and 1 more');
  });

  it('labels completion as output', () => {
    const lines = diffPrices(base, { ...base, completion: 16.5 });
    expect(summarizeDiff('m/x', lines)).toBe('m/x: output $15 → $16.5 per 1M (+10%)');
  });

  it('says no change, and describes added/removed', () => {
    expect(summarizeDiff('m/x', diffPrices(base, base))).toBe('m/x: no change');
    expect(summarizeDiff('m/x', diffPrices(null, base))).toBe('m/x: input added and 4 more');
  });

  it('rounds the percentage to one decimal and names the model', () => {
    const lines = diffPrices(base, { ...base, prompt: 3.333333333 });
    expect(summarizeDiff('m/x', lines, 'Model X')).toBe(
      'Model X: input $3 → $3.33333 per 1M (+11.1%)',
    );
  });
});

describe('formatPercent', () => {
  it('keeps one decimal, drops a trailing .0 and signs positives', () => {
    expect(formatPercent(11.11111111)).toBe('+11.1%');
    expect(formatPercent(100)).toBe('+100%');
    expect(formatPercent(-33.333333)).toBe('-33.3%');
    expect(formatPercent(10.04)).toBe('+10%');
  });
});
