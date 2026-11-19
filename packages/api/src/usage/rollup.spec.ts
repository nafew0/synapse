import mongoose from 'mongoose';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ITransaction, IUsageDaily } from '@librechat/data-schemas';
import { backfillUsageDaily, dhakaDay, rebuildDay, runUsageRollup } from './rollup';
import { CREDITS_PER_USD } from './packages';

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<ITransaction>;
let UsageDaily: mongoose.Model<IUsageDaily>;
let counter = 0;

const user = new mongoose.Types.ObjectId();
const otherUser = new mongoose.Types.ObjectId();

type Row = Partial<ITransaction> & { createdAt: Date; costUsd?: number };

/** A ledger row worth `usd`, written the way the app writes it. */
function row(over: Row & { usd: number }): Partial<ITransaction> {
  const { usd, ...rest } = over;
  counter += 1;
  return {
    user,
    tokenType: 'credits',
    tokenValue: -Math.round(usd * CREDITS_PER_USD),
    rawAmount: 1,
    service: 'firecrawl',
    modelKey: 'firecrawl/web_search',
    usageKind: 'web_search',
    usageUnit: 'operations',
    billable: true,
    requestKey: `k${counter}`,
    ...rest,
  };
}

const modelPair = (createdAt: Date, usd: number, extra: Partial<ITransaction> = {}) => [
  row({
    createdAt,
    usd: usd * 0.6,
    tokenType: 'prompt',
    rawAmount: -1000,
    service: 'openrouter',
    modelKey: 'claude-haiku-5.5',
    usageKind: 'message',
    usageUnit: 'tokens',
    valueKey: 'prompt',
    ...extra,
  }),
  row({
    createdAt,
    usd: usd * 0.4,
    tokenType: 'completion',
    rawAmount: -200,
    service: 'openrouter',
    modelKey: 'claude-haiku-5.5',
    usageKind: 'message',
    usageUnit: 'tokens',
    valueKey: 'completion',
    ...extra,
  }),
];

async function ledgerByDay(): Promise<Map<string, { rows: number; credits: number }>> {
  const all = await Transaction.find({}).lean();
  const days = new Map<string, { rows: number; credits: number }>();
  for (const tx of all) {
    const day = dhakaDay(tx.createdAt as Date);
    const total = days.get(day) ?? { rows: 0, credits: 0 };
    total.rows += 1;
    total.credits += -(tx.tokenValue ?? 0);
    days.set(day, total);
  }
  return days;
}

async function rollupByDay(): Promise<Map<string, { rows: number; credits: number }>> {
  const all = await UsageDaily.find({}).lean();
  const days = new Map<string, { rows: number; credits: number }>();
  for (const bucket of all) {
    const total = days.get(bucket.day) ?? { rows: 0, credits: 0 };
    total.rows += bucket.rows;
    total.credits += Math.round(bucket.costUsd * CREDITS_PER_USD);
    days.set(bucket.day, total);
  }
  return days;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  Transaction = mongoose.models.Transaction;
  UsageDaily = mongoose.models.UsageDaily;
  await Transaction.syncIndexes();
  await UsageDaily.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Transaction.deleteMany({});
  await UsageDaily.deleteMany({});
  await mongoose.models.UsageJob.deleteMany({});
});

const NOW = new Date('2026-11-14T05:00:00Z');

async function seedWeek(): Promise<void> {
  const rows = [
    /** Nov 10 Dhaka: the last second before midnight, then the first second of Nov 11. */
    row({ createdAt: new Date('2026-11-10T17:59:59Z'), usd: 0.0076, tenantId: 'a' }),
    row({ createdAt: new Date('2026-11-10T18:00:00Z'), usd: 0.0038, tenantId: 'a' }),
    ...modelPair(new Date('2026-11-11T03:00:00Z'), 0.02, {
      tenantId: 'a',
      taskType: 'word',
      messageId: 'm1',
    }),
    ...modelPair(new Date('2026-11-11T09:00:00Z'), 0.03, { tenantId: 'b', user: otherUser }),
    row({
      createdAt: new Date('2026-11-12T04:00:00Z'),
      usd: 0.001,
      tenantId: 'b',
      service: 'stt',
      modelKey: 'stt/voice',
      usageKind: 'voice',
      usageUnit: 'seconds',
      rawAmount: 30,
      taskType: 'voice',
    }),
    row({
      createdAt: new Date('2026-11-12T05:00:00Z'),
      usd: 0.0005,
      service: 'embeddings',
      modelKey: 'embeddings/embedding',
      usageKind: 'embedding',
      usageUnit: 'tokens',
      rawAmount: 3000,
      billable: false,
    }),
    row({
      createdAt: new Date('2026-11-12T06:00:00Z'),
      usd: 0.045,
      tenantId: 'a',
      service: 'unstructured',
      modelKey: 'unstructured/parse-fast',
      usageKind: 'ocr',
      usageUnit: 'operations',
      pages: 3,
    }),
    /** Written before `service` existed. */
    row({
      createdAt: new Date('2026-11-13T02:00:00Z'),
      usd: 0.045,
      tenantId: 'b',
      service: undefined,
      billable: undefined,
      usageKind: 'ocr',
      modelKey: 'unstructured/parse-fast',
      pages: 3,
    }),
    ...modelPair(new Date('2026-11-13T02:00:00Z'), 0.01, {
      service: undefined,
      billable: undefined,
    }),
  ];
  await Transaction.insertMany(rows);
}

describe('runUsageRollup', () => {
  it('matches the ledger total, day by day, across services, tenants and the Dhaka midnight', async () => {
    await seedWeek();
    const result = await runUsageRollup(NOW);

    expect(result.reconciliations.every((check) => check.ok)).toBe(true);
    const ledger = await ledgerByDay();
    const rollup = await rollupByDay();
    expect([...rollup.keys()].sort()).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    for (const [day, totals] of ledger) {
      expect(rollup.get(day)).toEqual(totals);
    }
  });

  it('puts 23:59:59 and 00:00:00 Dhaka time on different days', async () => {
    await seedWeek();
    await runUsageRollup(NOW);
    const nov10 = await UsageDaily.find({ day: '2026-11-10' }).lean();
    const nov11 = await UsageDaily.find({ day: '2026-11-11', service: 'firecrawl' }).lean();
    expect(nov10).toHaveLength(1);
    expect(nov10[0].costUsd).toBeCloseTo(0.0076, 9);
    expect(nov11).toHaveLength(1);
    expect(nov11[0].costUsd).toBeCloseTo(0.0038, 9);
  });

  it('keeps services, billable cost and tenants apart and derives the service of old rows', async () => {
    await seedWeek();
    await runUsageRollup(NOW);
    const day12 = await UsageDaily.find({ day: '2026-11-12' }).lean();
    const embedding = day12.find((bucket) => bucket.service === 'embeddings');
    expect(embedding).toMatchObject({ billable: false, units: 3000 });
    expect(embedding?.tenantId).toBeUndefined();
    const ocr = day12.find((bucket) => bucket.service === 'unstructured');
    expect(ocr).toMatchObject({ tenantId: 'a', pages: 3, billable: true });

    const day13 = await UsageDaily.find({ day: '2026-11-13' }).lean();
    expect(day13.map((bucket) => bucket.service).sort()).toEqual(['openrouter', 'unstructured']);
    expect(day13.every((bucket) => bucket.billable)).toBe(true);

    const model = await UsageDaily.findOne({
      day: '2026-11-11',
      tenantId: 'a',
      service: 'openrouter',
    }).lean();
    expect(model).toMatchObject({
      taskType: 'word',
      requests: 1,
      inputTokens: 1000,
      outputTokens: 200,
      rows: 2,
    });
    expect(model?.costUsd).toBeCloseTo(0.02, 9);
  });

  it('matches the ledger on 300 mixed rows over eight days and three tenants', async () => {
    const services = ['firecrawl', 'stt', 'embeddings', 'unstructured'];
    const tenants = ['a', 'b', 'c', undefined];
    const start = new Date('2026-11-06T00:00:00Z').getTime();
    const rows = Array.from({ length: 300 }, (_, index) => {
      const createdAt = new Date(start + ((index * 7919) % (8 * 24 * 60)) * 60_000);
      const tenantId = tenants[index % tenants.length];
      return index % 3 === 0
        ? modelPair(createdAt, 0.001 * ((index % 17) + 1), { tenantId })
        : [
            row({
              createdAt,
              usd: 0.0003 * ((index % 11) + 1),
              tenantId,
              service: services[index % 4] as never,
            }),
          ];
    }).flat();
    await Transaction.insertMany(rows);

    const result = await runUsageRollup(NOW);

    expect(result.reconciliations.every((check) => check.ok)).toBe(true);
    const ledger = await ledgerByDay();
    const rollup = await rollupByDay();
    expect(rollup.size).toBe(ledger.size);
    for (const [day, totals] of ledger) {
      expect(rollup.get(day)).toEqual(totals);
    }
  });

  it('gives the same rows when run twice, and when nothing changed in between', async () => {
    await seedWeek();
    await runUsageRollup(NOW);
    const first = await UsageDaily.find({}).sort({ key: 1 }).lean();
    const second = await runUsageRollup(NOW);
    const after = await UsageDaily.find({}).sort({ key: 1 }).lean();

    expect(second.reconciliations.every((check) => check.ok)).toBe(true);
    expect(after.map((bucket) => [bucket._id, bucket.key, bucket.costUsd, bucket.rows])).toEqual(
      first.map((bucket) => [bucket._id, bucket.key, bucket.costUsd, bucket.rows]),
    );
  });

  it('only rebuilds the days with new rows, plus today and yesterday, and picks the new rows up', async () => {
    await seedWeek();
    await runUsageRollup(NOW);
    await Transaction.insertMany([
      row({ createdAt: new Date('2026-11-12T10:00:00Z'), usd: 0.0038 }),
    ]);
    const result = await runUsageRollup(NOW);

    expect(result.days).toEqual(['2026-11-12', '2026-11-13', '2026-11-14']);
    const ledger = await ledgerByDay();
    expect(await rollupByDay()).toEqual(
      new Map([...ledger].filter(([day]) => day >= '2026-11-10')),
    );
  });

  it('drops a bucket when its rows are re-tagged, instead of keeping the stale one', async () => {
    await Transaction.insertMany(
      modelPair(new Date('2026-11-14T01:00:00Z'), 0.02, { messageId: 'm9' }),
    );
    await runUsageRollup(NOW);
    expect(await UsageDaily.countDocuments({ taskType: { $exists: false } })).toBe(1);

    await Transaction.updateMany({ messageId: 'm9' }, { $set: { taskType: 'chat' } });
    await runUsageRollup(NOW);

    const buckets = await UsageDaily.find({}).lean();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].taskType).toBe('chat');
  });

  it('skips while another run holds the lease', async () => {
    await seedWeek();
    await mongoose.models.UsageJob.create({
      name: 'usage-rollup',
      lockedUntil: new Date(NOW.getTime() + 60_000),
    });
    const result = await runUsageRollup(NOW);
    expect(result.skipped).toBe('locked');
    expect(await UsageDaily.countDocuments()).toBe(0);
  });
});

describe('rebuildDay', () => {
  it('reports a mismatch when the rollup does not equal the ledger', async () => {
    await seedWeek();
    const good = await rebuildDay('2026-11-12', NOW);
    expect(good.ok).toBe(true);

    await UsageDaily.updateOne({ day: '2026-11-12', service: 'stt' }, { $set: { costUsd: 99 } });
    const bad = await rollupByDay();
    expect(bad.get('2026-11-12')?.credits).not.toBe(
      (await ledgerByDay()).get('2026-11-12')?.credits,
    );

    const healed = await rebuildDay('2026-11-12', NOW);
    expect(healed.ok).toBe(true);
  });
});

describe('backfillUsageDaily', () => {
  it('prints the totals per month and service on a dry run and writes nothing', async () => {
    await seedWeek();
    const result = await backfillUsageDaily({ dryRun: true, now: NOW });

    expect(result).toMatchObject({ dryRun: true, from: '2026-11-10', to: '2026-11-14', days: 5 });
    expect(await UsageDaily.countDocuments()).toBe(0);
    const total = result.months.reduce((sum, month) => sum + month.costUsd, 0);
    const ledgerTotal = [...(await ledgerByDay()).values()].reduce(
      (sum, day) => sum + day.credits,
      0,
    );
    expect(total * CREDITS_PER_USD).toBeCloseTo(ledgerTotal, 3);
    expect(result.months.map((month) => month.service).sort()).toEqual([
      'embeddings',
      'firecrawl',
      'openrouter',
      'stt',
      'unstructured',
    ]);
  });

  it('builds every day from the first row, reconciles, and leaves the watermark for the job', async () => {
    await seedWeek();
    const result = await backfillUsageDaily({ now: NOW });

    expect(result.reconciliations).toHaveLength(5);
    expect(result.reconciliations.every((check) => check.ok)).toBe(true);
    const ledger = await ledgerByDay();
    const rollup = await rollupByDay();
    for (const [day, totals] of ledger) {
      expect(rollup.get(day)).toEqual(totals);
    }
    const job = await mongoose.models.UsageJob.findOne({ name: 'usage-rollup' }).lean<{
      watermark?: unknown;
    }>();
    expect(job?.watermark).toBeDefined();

    const next = await runUsageRollup(NOW);
    expect(next.days).toEqual(['2026-11-13', '2026-11-14']);
  });

  it('does nothing on an empty ledger', async () => {
    expect(await backfillUsageDaily({ now: NOW })).toMatchObject({ days: 0, months: [] });
  });
});
