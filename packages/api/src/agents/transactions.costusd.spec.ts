import type { TransactionData } from '@librechat/data-schemas';
import type { PricingFns, PreparedEntry, BulkWriteDeps, TxMetadata } from './transactions';
import type { RecordUsageDeps } from './usage';
import { applyProviderCost, prepareTokenSpend } from './transactions';
import { recordCollectedUsage } from './usage';

const entry = (tokenValue: number, extra: Partial<TransactionData> = {}): PreparedEntry => ({
  tokenValue,
  balance: { enabled: true },
  doc: { tokenValue, user: 'u1', ...extra } as TransactionData,
});

describe('applyProviderCost', () => {
  it('scales rows to exactly the provider amount and records each row as costUsd', () => {
    const entries = [entry(-3000), entry(-1000)];
    applyProviderCost(entries, 0.01);
    expect(entries.map((e) => e.tokenValue)).toEqual([-7500, -2500]);
    expect(entries.map((e) => e.doc.tokenValue)).toEqual([-7500, -2500]);
    expect(entries.map((e) => e.doc.costUsd)).toEqual([0.0075, 0.0025]);
    expect(entries.every((e) => e.doc.costSource === 'provider')).toBe(true);
    const total = entries.reduce((sum, e) => sum + Math.abs(e.tokenValue), 0);
    expect(total).toBe(10000);
  });

  it('scales up as well as down and handles a single row', () => {
    const entries = [entry(-50)];
    applyProviderCost(entries, 0.0002);
    expect(entries[0].tokenValue).toBe(-200);
    expect(entries[0].doc.costUsd).toBe(0.0002);
  });

  it.each([
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -0.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('ignores %s', (_label, cost) => {
    const entries = [entry(-3000), entry(-1000)];
    applyProviderCost(entries, cost as number | undefined);
    expect(entries.map((e) => e.tokenValue)).toEqual([-3000, -1000]);
    expect(
      entries.every((e) => e.doc.costUsd === undefined && e.doc.costSource === undefined),
    ).toBe(true);
  });

  it('does nothing when the rows carry no credits to scale', () => {
    const entries = [entry(0), entry(0)];
    applyProviderCost(entries, 0.5);
    expect(entries.map((e) => e.tokenValue)).toEqual([0, 0]);
    expect(entries[0].doc.costUsd).toBeUndefined();
    expect(() => applyProviderCost([], 0.5)).not.toThrow();
  });

  it('works on rows built by prepareTokenSpend', () => {
    const pricing: PricingFns = {
      getMultiplier: ({ tokenType }) => (tokenType === 'completion' ? 5 : 1),
      getCacheMultiplier: () => null,
    };
    const rows = prepareTokenSpend(
      { user: 'u1', conversationId: 'c1', context: 'message', model: 'm' } as TxMetadata,
      { promptTokens: 1000, completionTokens: 200 },
      pricing,
    );
    expect(rows.map((r) => r.tokenValue)).toEqual([-1000, -1000]);
    applyProviderCost(rows, 0.0123);
    expect(rows.reduce((sum, r) => sum + Math.abs(r.tokenValue), 0)).toBe(12300);
    expect(rows.map((r) => r.doc.costUsd)).toEqual([0.00615, 0.00615]);
  });
});

describe('recordCollectedUsage with provider_cost_usd', () => {
  const pricing: PricingFns = {
    getMultiplier: ({ tokenType }) => (tokenType === 'completion' ? 2 : 1),
    getCacheMultiplier: () => null,
  };
  const params = {
    user: 'user-1',
    conversationId: 'convo-1',
    model: 'anthropic/claude-haiku-5.5',
    context: 'message' as const,
    balance: { enabled: true },
    transactions: { enabled: true },
  };

  const build = () => {
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const updateBalance = jest.fn().mockResolvedValue({});
    const bulkWriteOps: BulkWriteDeps = { insertMany, updateBalance };
    const deps: RecordUsageDeps = {
      spendTokens: jest.fn(),
      spendStructuredTokens: jest.fn(),
      pricing,
      bulkWriteOps,
    };
    return { deps, insertMany, updateBalance };
  };

  it('stores costUsd and costSource on the inserted docs and charges the scaled balance', async () => {
    const { deps, insertMany, updateBalance } = build();
    const result = await recordCollectedUsage(deps, {
      ...params,
      collectedUsage: [
        { input_tokens: 1000, output_tokens: 500, model: params.model, provider_cost_usd: 0.002 },
      ],
    });
    const docs = insertMany.mock.calls[0][0] as TransactionData[];
    expect(docs).toHaveLength(2);
    expect(docs.reduce((sum, d) => sum + Math.abs(d.tokenValue ?? 0), 0)).toBe(2000);
    expect(docs.map((d) => d.costUsd)).toEqual([0.001, 0.001]);
    expect(docs.every((d) => d.costSource === 'provider')).toBe(true);
    expect(updateBalance).toHaveBeenCalledWith({ user: 'user-1', incrementValue: -2000 });
    expect(result?.credits).toBe(2000);
  });

  it('keeps table-priced values and no costUsd when the provider reports no cost', async () => {
    const { deps, insertMany, updateBalance } = build();
    await recordCollectedUsage(deps, {
      ...params,
      collectedUsage: [{ input_tokens: 1000, output_tokens: 500, model: params.model }],
    });
    const docs = insertMany.mock.calls[0][0] as TransactionData[];
    expect(docs.map((d) => d.tokenValue)).toEqual([-1000, -1000]);
    expect(docs.every((d) => d.costUsd === undefined && d.costSource === undefined)).toBe(true);
    expect(updateBalance).toHaveBeenCalledWith({ user: 'user-1', incrementValue: -2000 });
  });

  it('scales each call to its own provider cost', async () => {
    const { deps, insertMany, updateBalance } = build();
    await recordCollectedUsage(deps, {
      ...params,
      collectedUsage: [
        { input_tokens: 100, output_tokens: 50, model: params.model, provider_cost_usd: 0.001 },
        { input_tokens: 400, output_tokens: 100, model: params.model },
      ],
    });
    const docs = insertMany.mock.calls[0][0] as TransactionData[];
    expect(docs).toHaveLength(4);
    expect(docs.slice(0, 2).map((d) => d.costSource)).toEqual(['provider', 'provider']);
    expect(docs.slice(2).map((d) => d.costSource)).toEqual([undefined, undefined]);
    expect(Math.abs((docs[0].tokenValue ?? 0) + (docs[1].tokenValue ?? 0))).toBe(1000);
    const expectedBalance = docs.reduce((sum, d) => sum + (d.tokenValue ?? 0), 0);
    expect(updateBalance).toHaveBeenCalledWith({ user: 'user-1', incrementValue: expectedBalance });
  });
});
