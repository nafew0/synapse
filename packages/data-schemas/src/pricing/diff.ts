import type { PriceBlock, PriceDiffLine, PriceTier } from '~/types/modelPrice';

const BLOCK_FIELDS = [
  'prompt',
  'completion',
  'cacheRead',
  'cacheWrite',
  'cacheWrite1h',
  'reasoning',
  'image',
  'imageOutput',
  'audio',
  'audioOutput',
  'webSearch',
  'contextLength',
] as const;

const TIER_FIELDS = ['prompt', 'completion', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;

const round = (value: number): number => Number(value.toPrecision(10));

function line(field: string, previous?: number | null, current?: number | null): PriceDiffLine {
  const before = previous ?? null;
  const after = current ?? null;
  if (before == null && after == null) {
    return {
      field,
      previous: null,
      current: null,
      change: null,
      changePct: null,
      kind: 'unchanged',
    };
  }
  if (before == null || after == null) {
    return {
      field,
      previous: before,
      current: after,
      change: null,
      changePct: null,
      kind: before == null ? 'added' : 'removed',
    };
  }
  const change = round(after - before);
  return {
    field,
    previous: before,
    current: after,
    change,
    changePct: before === 0 ? null : round((change / before) * 100),
    kind: change === 0 ? 'unchanged' : 'changed',
  };
}

const tierMap = (tiers: PriceTier[] = []): Map<number, PriceTier> =>
  new Map(tiers.map((tier) => [tier.minPromptTokens, tier]));

/**
 * Field-by-field difference between two price versions, tiers included. `previous` null means a
 * first price: every present field is `added`. Unchanged fields stay in the list so a reader can show them.
 * One function feeds the panel, the stored version and the audit entry, so they always agree.
 */
export function diffPrices(
  previous: PriceBlock | null | undefined,
  current: PriceBlock,
): PriceDiffLine[] {
  const lines: PriceDiffLine[] = BLOCK_FIELDS.map((field) =>
    line(field, previous?.[field], current[field]),
  ).filter((entry) => entry.kind !== 'unchanged' || entry.current != null);

  const before = tierMap(previous?.tiers);
  const after = tierMap(current.tiers);
  const thresholds = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  for (const threshold of thresholds) {
    const was = before.get(threshold);
    const now = after.get(threshold);
    for (const field of TIER_FIELDS) {
      const entry = line(`tier:${threshold}:${field}`, was?.[field], now?.[field]);
      if (entry.kind !== 'unchanged' || entry.current != null) {
        lines.push(entry);
      }
    }
  }
  return lines;
}

export const changedLines = (lines: PriceDiffLine[]): PriceDiffLine[] =>
  lines.filter((entry) => entry.kind !== 'unchanged');

/** Same numbers in both blocks, tiers included. */
export const samePrice = (a: PriceBlock, b: PriceBlock): boolean =>
  changedLines(diffPrices(a, b)).length === 0;

const money = (value: number): string => `$${Number(value.toPrecision(6))}`;

/** One decimal, trailing ".0" dropped, explicit sign: 11.11111 → "+11.1%", -50 → "-50%". */
export function formatPercent(value: number): string {
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** One sentence for a notice: "Claude Haiku: output $3.75 → $4.125 per 1M (+10%)"; `name` falls back to the id. */
export function summarizeDiff(modelId: string, lines: PriceDiffLine[], name?: string): string {
  const title = name || modelId;
  const changed = changedLines(lines);
  if (changed.length === 0) {
    return `${title}: no change`;
  }
  const first = changed[0];
  const label = first.field.replace('completion', 'output').replace('prompt', 'input');
  const detail =
    first.kind === 'changed'
      ? `${label} ${money(first.previous as number)} → ${money(first.current as number)} per 1M${first.changePct != null ? ` (${formatPercent(first.changePct)})` : ''}`
      : `${label} ${first.kind}`;
  const more = changed.length > 1 ? ` and ${changed.length - 1} more` : '';
  return `${title}: ${detail}${more}`;
}
