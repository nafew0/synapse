import mongoose from 'mongoose';
import { runAsSystem, ratesFor } from '@librechat/data-schemas';
import type { PriceBlock } from '@librechat/data-schemas';

const WINDOW_DAYS = 30;
const MAX_ROWS = 100_000;
const CREDITS_PER_USD = 1_000_000;

interface LedgerRow {
  tokenType?: string;
  requestKey?: string;
  rawAmount?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  tokenValue?: number;
}

export interface CostEffect {
  windowDays: number;
  calls: number;
  /** True when the window held more rows than were read. */
  truncated: boolean;
  recordedUsd: number;
  atPreviousUsd: number | null;
  atCurrentUsd: number;
  differenceUsd: number | null;
}

const abs = (value?: number): number => Math.abs(value ?? 0);

/** USD for one ledger row under a price block; a completion row takes its tier from its call's prompt size. */
function rowCost(row: LedgerRow, price: PriceBlock, promptTokens: number): number {
  const rates = ratesFor(price, promptTokens);
  if (row.tokenType === 'completion') {
    return (abs(row.rawAmount) * rates.completion) / 1e6;
  }
  const hasSplit = row.inputTokens != null || row.writeTokens != null || row.readTokens != null;
  if (!hasSplit) {
    return (abs(row.rawAmount) * rates.prompt) / 1e6;
  }
  const input = abs(row.inputTokens) * rates.prompt;
  const write = abs(row.writeTokens) * (rates.cacheWrite ?? rates.prompt);
  const read = abs(row.readTokens) * (rates.cacheRead ?? rates.prompt);
  return (input + write + read) / 1e6;
}

const promptSize = (row: LedgerRow): number =>
  row.inputTokens != null || row.writeTokens != null || row.readTokens != null
    ? abs(row.inputTokens) + abs(row.writeTokens) + abs(row.readTokens)
    : abs(row.rawAmount);

/**
 * What the last 30 days of one model's real usage would have cost at the previous and at the current
 * price, tier by tier per call. Reads the ledger rows (prompt and completion rows of a call share a
 * `requestKey`); `recordedUsd` is what was actually booked.
 */
export async function costEffect(
  modelId: string,
  current: PriceBlock,
  previous: PriceBlock | null | undefined,
  now: Date = new Date(),
): Promise<CostEffect> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await runAsSystem(() =>
    mongoose.models.Transaction.find({
      model: modelId,
      createdAt: { $gte: since },
      tokenType: { $in: ['prompt', 'completion'] },
    })
      .select('tokenType requestKey rawAmount inputTokens writeTokens readTokens tokenValue')
      .limit(MAX_ROWS + 1)
      .lean<LedgerRow[]>(),
  );
  const truncated = rows.length > MAX_ROWS;
  const used = truncated ? rows.slice(0, MAX_ROWS) : rows;
  const promptByCall = new Map<string, number>();
  for (const row of used) {
    if (row.tokenType === 'prompt' && row.requestKey) {
      promptByCall.set(row.requestKey, promptSize(row));
    }
  }
  const totals = used.reduce(
    (sum, row) => {
      const prompt =
        row.tokenType === 'completion'
          ? (promptByCall.get(row.requestKey ?? '') ?? 0)
          : promptSize(row);
      return {
        recorded: sum.recorded + abs(row.tokenValue) / CREDITS_PER_USD,
        previous: sum.previous + (previous ? rowCost(row, previous, prompt) : 0),
        current: sum.current + rowCost(row, current, prompt),
        calls: sum.calls + (row.tokenType === 'prompt' ? 1 : 0),
      };
    },
    { recorded: 0, previous: 0, current: 0, calls: 0 },
  );
  const round = (value: number): number => Number(value.toFixed(6));
  return {
    windowDays: WINDOW_DAYS,
    calls: totals.calls,
    truncated,
    recordedUsd: round(totals.recorded),
    atPreviousUsd: previous ? round(totals.previous) : null,
    atCurrentUsd: round(totals.current),
    differenceUsd: previous ? round(totals.current - totals.previous) : null,
  };
}
