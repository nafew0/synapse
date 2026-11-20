import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createTxMethods } from '@librechat/data-schemas';
import type {
  ITransaction,
  IUsageBucket,
  IUsageDaily,
  TransactionData,
} from '@librechat/data-schemas';
import type { PricingFns, TxMetadata } from '~/agents/transactions';
import { prepareStructuredTokenSpend, prepareTokenSpend } from '~/agents/transactions';
import { correctHaikuTierCosts, HAIKU_5_5_PATTERN } from './correction';
import { matchModelName, findMatchingPattern } from '~/utils';

const { getMultiplier, getCacheMultiplier } = createTxMethods(mongoose, {
  matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
});

const tiered: PricingFns = { getMultiplier, getCacheMultiplier };
/** What production recorded before the tier existed: the same functions with no prompt size, so the base rate. */
const flat: PricingFns = {
  getMultiplier: (params) => getMultiplier({ ...params, inputTokenCount: undefined }),
  getCacheMultiplier: (params) => getCacheMultiplier({ ...params, inputTokenCount: undefined }),
};

const MODEL = 'anthropic/claude-haiku-5.5';
const DASHED = 'claude-haiku-5-5';

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<ITransaction>;
let UsageBucket: mongoose.Model<IUsageBucket>;
let UsageDaily: mongoose.Model<IUsageDaily>;
let auditDir: string;
let counter = 0;

const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();

interface Call {
  tenantId: string;
  user: mongoose.Types.ObjectId;
  at: string;
  model?: string;
  input: number;
  write?: number;
  read?: number;
  completion: number;
}

/** One model call written the way the app wrote it before the fix: flat rates, a prompt and a completion row. */
function callRows(call: Call): (TransactionData & { createdAt: Date })[] {
  counter += 1;
  const meta = {
    user: String(call.user),
    tenantId: call.tenantId,
    conversationId: `c${counter}`,
    messageId: `m${counter}`,
    model: call.model ?? MODEL,
    modelKey: 'claude-haiku-5.5',
    providerKey: 'openrouter',
    context: 'message',
    usageKind: 'message',
    usageUnit: 'tokens',
    service: 'openrouter',
    requestKey: `c${counter}:m${counter}:run:message:openrouter:${call.model ?? MODEL}:0`,
  } as TxMetadata;
  const cached = (call.write ?? 0) > 0 || (call.read ?? 0) > 0;
  const entries = cached
    ? prepareStructuredTokenSpend(
        meta,
        {
          promptTokens: { input: call.input, write: call.write ?? 0, read: call.read ?? 0 },
          completionTokens: call.completion,
        },
        flat,
      )
    : prepareTokenSpend(
        meta,
        { promptTokens: call.input, completionTokens: call.completion },
        flat,
      );
  return entries.map((entry) => ({ ...entry.doc, createdAt: new Date(call.at) }));
}

async function seed(calls: Call[]): Promise<void> {
  await Transaction.insertMany(calls.flatMap(callRows));
}

const credits = (tx: { tokenValue?: number }): number => Math.abs(tx.tokenValue ?? 0);
const sumCredits = async (filter: object = {}): Promise<number> =>
  (await Transaction.find(filter).lean()).reduce((sum, tx) => sum + credits(tx), 0);

/** Credits a call costs at the tiered rate, from the same pricing functions the app uses. */
function expected(call: Call): number {
  const prompt = call.input + (call.write ?? 0) + (call.read ?? 0);
  const model = call.model ?? MODEL;
  const input = getMultiplier({ model, tokenType: 'prompt', inputTokenCount: prompt });
  const write = getCacheMultiplier({ model, cacheType: 'write', inputTokenCount: prompt }) ?? input;
  const read = getCacheMultiplier({ model, cacheType: 'read', inputTokenCount: prompt }) ?? input;
  const out = getMultiplier({ model, tokenType: 'completion', inputTokenCount: prompt });
  return (
    call.input * input + (call.write ?? 0) * write + (call.read ?? 0) * read + call.completion * out
  );
}

const run = (over: Partial<Parameters<typeof correctHaikuTierCosts>[0]> = {}) =>
  correctHaikuTierCosts({ pricing: tiered, dryRun: false, auditDir, ...over });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  Transaction = mongoose.models.Transaction;
  UsageBucket = mongoose.models.UsageBucket;
  UsageDaily = mongoose.models.UsageDaily;
  await Transaction.syncIndexes();
  await UsageBucket.syncIndexes();
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-correction-'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(auditDir, { recursive: true, force: true });
});

beforeEach(async () => {
  counter = 0;
  await Transaction.deleteMany({});
  await UsageBucket.deleteMany({});
  await UsageDaily.deleteMany({});
  fs.readdirSync(auditDir).forEach((file) => fs.rmSync(path.join(auditDir, file)));
});

const SMALL: Call = {
  tenantId: 'a',
  user: userA,
  at: '2026-11-03T05:00:00Z',
  input: 50_000,
  completion: 1_000,
};
const LONG: Call = {
  tenantId: 'a',
  user: userA,
  at: '2026-11-04T05:00:00Z',
  input: 150_000,
  completion: 2_000,
};
const LONG_CACHED: Call = {
  tenantId: 'a',
  user: userA,
  at: '2026-11-04T06:00:00Z',
  input: 5_000,
  write: 10_000,
  read: 120_000,
  completion: 1_500,
};
const LONG_DASHED_B: Call = {
  tenantId: 'b',
  user: userB,
  at: '2026-10-28T05:00:00Z',
  model: DASHED,
  input: 200_000,
  completion: 3_000,
};

describe('HAIKU_5_5_PATTERN', () => {
  it.each(['anthropic/claude-haiku-5.5', 'claude-haiku-5-5', 'Claude-Haiku-5.5-20261001'])(
    'matches %s',
    (model) => {
      expect(HAIKU_5_5_PATTERN.test(model)).toBe(true);
    },
  );
  it.each(['claude-haiku-4.5', 'claude-3-5-haiku', 'claude-sonnet-5.5'])('skips %s', (model) => {
    expect(HAIKU_5_5_PATTERN.test(model)).toBe(false);
  });
});

describe('correctHaikuTierCosts', () => {
  it('writes nothing on a dry run but reports before and after per month and tenant', async () => {
    await seed([SMALL, LONG, LONG_CACHED, LONG_DASHED_B]);
    const before = await Transaction.find({}).sort({ _id: 1 }).lean();

    const result = await run({ dryRun: true });

    expect(await Transaction.find({}).sort({ _id: 1 }).lean()).toEqual(before);
    expect(fs.readdirSync(auditDir)).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.rowsScanned).toBe(8);
    expect(result.rowsChanged).toBe(6);
    expect(result.rowsAlreadyCorrect).toBe(2);
    const slice = (month: string, tenantId: string) =>
      result.slices.find((s) => s.month === month && s.tenantId === tenantId);
    expect(slice('2026-11', 'a')?.rows).toBe(6);
    expect(slice('2026-10', 'b')?.rows).toBe(2);
    expect(slice('2026-11', 'a')?.afterUsd).toBeGreaterThan(slice('2026-11', 'a')!.beforeUsd);
    const afterA = (expected(SMALL) + expected(LONG) + expected(LONG_CACHED)) / 1e6;
    expect(slice('2026-11', 'a')?.afterUsd).toBeCloseTo(afterA, 6);
  });

  it('reprices rows above the threshold, leaves rows below it, and handles cache reads and writes', async () => {
    await seed([SMALL, LONG, LONG_CACHED, LONG_DASHED_B]);
    const smallBefore = await Transaction.find({ tenantId: 'a', conversationId: 'c1' }).lean();

    const result = await run();

    expect(result.rowsChanged).toBe(6);
    expect(await Transaction.find({ tenantId: 'a', conversationId: 'c1' }).lean()).toEqual(
      smallBefore,
    );
    expect(await sumCredits({ tenantId: 'a' })).toBeCloseTo(
      expected(SMALL) + expected(LONG) + expected(LONG_CACHED),
      3,
    );
    expect(await sumCredits({ tenantId: 'b' })).toBeCloseTo(expected(LONG_DASHED_B), 3);
    const long = await Transaction.findOne({ conversationId: 'c2', tokenType: 'prompt' }).lean();
    expect(long?.rate).toBeCloseTo(0.5, 6);
    expect(long?.costCorrection?.previousRate).toBeCloseTo(0.1, 6);
    expect(long?.costCorrection?.id).toBe('haiku-5.5-long-prompt-tier');
  });

  it('is idempotent: a second run changes nothing and the totals stay put', async () => {
    await seed([SMALL, LONG, LONG_CACHED, LONG_DASHED_B]);
    await UsageBucket.create({
      tenantId: 'a',
      periodStart: new Date('2026-10-31T18:00:00Z'),
      periodEnd: new Date('2026-11-30T18:00:00Z'),
      scopeType: 'institution_credits',
      scopeKey: 'a',
      policyVersion: 1,
      usedTokens: 1_000,
      createdAt: new Date('2026-10-31T18:00:00Z'),
    });

    await run();
    const afterFirst = await Transaction.find({}).sort({ _id: 1 }).lean();
    const bucketFirst = await UsageBucket.findOne({ scopeKey: 'a' }).lean();
    const second = await run();

    expect(second.rowsChanged).toBe(0);
    expect(second.buckets).toEqual([]);
    expect(await Transaction.find({}).sort({ _id: 1 }).lean()).toEqual(afterFirst);
    expect((await UsageBucket.findOne({ scopeKey: 'a' }).lean())?.usedTokens).toBe(
      bucketFirst?.usedTokens,
    );
  });

  it('adds the credit difference to the buckets that counted the row, month and week, per scope', async () => {
    await seed([LONG]);
    const base = {
      policyVersion: 1,
      usedTokens: 10_000,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    };
    await UsageBucket.insertMany([
      {
        ...base,
        tenantId: 'a',
        scopeType: 'institution_credits',
        scopeKey: 'a',
        periodStart: new Date('2026-10-31T18:00:00Z'),
        periodEnd: new Date('2026-11-30T18:00:00Z'),
      },
      {
        ...base,
        tenantId: 'a',
        scopeType: 'member_credits',
        scopeKey: String(userA),
        periodStart: new Date('2026-10-31T18:00:00Z'),
        periodEnd: new Date('2026-11-30T18:00:00Z'),
      },
      {
        ...base,
        tenantId: 'a',
        scopeType: 'member_credits',
        scopeKey: String(userA),
        periodStart: new Date('2026-11-01T18:00:00Z'),
        periodEnd: new Date('2026-11-08T18:00:00Z'),
      },
      /** Another member's bucket and an earlier month: untouched. */
      {
        ...base,
        tenantId: 'a',
        scopeType: 'member_credits',
        scopeKey: String(userB),
        periodStart: new Date('2026-10-31T18:00:00Z'),
        periodEnd: new Date('2026-11-30T18:00:00Z'),
      },
      {
        ...base,
        tenantId: 'a',
        scopeType: 'member_credits',
        scopeKey: String(userA),
        periodStart: new Date('2026-09-30T18:00:00Z'),
        periodEnd: new Date('2026-10-31T18:00:00Z'),
      },
      /** A model-token bucket counts tokens, not credits: untouched. */
      {
        ...base,
        tenantId: 'a',
        scopeType: 'model',
        scopeKey: 'claude-haiku-5.5',
        periodStart: new Date('2026-10-31T18:00:00Z'),
        periodEnd: new Date('2026-11-30T18:00:00Z'),
      },
    ]);
    const added =
      expected(LONG) - (await Transaction.find({}).lean()).reduce((s, t) => s + credits(t), 0);

    await run();

    const used = async (scopeType: string, scopeKey: string, start: string) =>
      (await UsageBucket.findOne({ scopeType, scopeKey, periodStart: new Date(start) }).lean())
        ?.usedTokens;
    expect(await used('institution_credits', 'a', '2026-10-31T18:00:00Z')).toBe(
      10_000 + Math.round(added),
    );
    expect(await used('member_credits', String(userA), '2026-10-31T18:00:00Z')).toBe(
      10_000 + Math.round(added),
    );
    expect(await used('member_credits', String(userA), '2026-11-01T18:00:00Z')).toBe(
      10_000 + Math.round(added),
    );
    expect(await used('member_credits', String(userB), '2026-10-31T18:00:00Z')).toBe(10_000);
    expect(await used('member_credits', String(userA), '2026-09-30T18:00:00Z')).toBe(10_000);
    expect(await used('model', 'claude-haiku-5.5', '2026-10-31T18:00:00Z')).toBe(10_000);
  });

  it('rebuilds the daily rollup of the days it changed', async () => {
    await seed([LONG]);

    const result = await run();

    expect(result.days).toEqual(['2026-11-04']);
    const daily = await UsageDaily.find({ day: '2026-11-04' }).lean();
    const costUsd = daily.reduce((sum, d) => sum + d.costUsd, 0);
    expect(costUsd).toBeCloseTo(expected(LONG) / 1e6, 6);
  });

  it('writes an audit note with every row before and after, started then completed', async () => {
    await seed([LONG]);

    const result = await run();

    expect(result.auditFile).toBeDefined();
    expect(fs.readdirSync(auditDir)).toHaveLength(1);
    const note = JSON.parse(fs.readFileSync(result.auditFile as string, 'utf8'));
    expect(note.status).toBe('completed');
    expect(note.runId).toBe(result.runId);
    expect(note.changes).toHaveLength(2);
    expect(note.changes[0].before.tokenValue).not.toBe(note.changes[0].after.tokenValue);
  });

  it('ignores other models, skips a completion with no prompt row, and honours the tenant and since filters', async () => {
    await seed([LONG, LONG_DASHED_B, { ...LONG, model: 'anthropic/claude-haiku-4.5' }]);
    await Transaction.deleteOne({ conversationId: 'c1', tokenType: 'prompt' });
    const otherModel = await Transaction.find({ model: 'anthropic/claude-haiku-4.5' }).lean();

    const onlyB = await run({ tenantId: 'b' });
    expect(onlyB.rowsChanged).toBe(2);
    const since = await run({ since: new Date('2026-11-01T00:00:00Z') });

    expect(since.rowsUnpaired).toBe(1);
    expect(since.rowsChanged).toBe(0);
    expect(await Transaction.find({ model: 'anthropic/claude-haiku-4.5' }).lean()).toEqual(
      otherModel,
    );
  });
});
