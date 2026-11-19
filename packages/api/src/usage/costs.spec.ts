import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, TASK_TYPES } from '@librechat/data-schemas';
import type { ITransaction, ITaskCostProfile, TaskType } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  percentile,
  buildProfile,
  getTaskCostProfile,
  createTaskCostHandlers,
  createProductKeyGuard,
  computeTaskCostProfile,
} from './costs';
import { CREDITS_PER_USD } from './packages';

const NOW = new Date('2026-11-14T05:00:00Z');
const KEY = 'test-product-key';
const user = new mongoose.Types.ObjectId();

let mongoServer: MongoMemoryServer;
let Transaction: mongoose.Model<ITransaction>;
let TaskCostProfile: mongoose.Model<ITaskCostProfile>;
let server: Server;
let base: string;
let configuredKey: string | undefined = KEY;
let counter = 0;

/** One settled request: a prompt row and a completion row sharing a message id, worth `usd` together. */
function request(
  taskType: TaskType,
  usd: number,
  over: Partial<ITransaction> = {},
): Partial<ITransaction>[] {
  counter += 1;
  const common = {
    user,
    taskType,
    messageId: `m${counter}`,
    conversationId: 'c',
    service: 'openrouter' as const,
    billable: true,
    createdAt: new Date('2026-11-10T04:00:00Z'),
    ...over,
  };
  return [
    {
      ...common,
      tokenType: 'prompt',
      valueKey: 'prompt',
      requestKey: `p${counter}`,
      tokenValue: -Math.round(usd * 0.7 * CREDITS_PER_USD),
    },
    {
      ...common,
      tokenType: 'completion',
      valueKey: 'completion',
      requestKey: `q${counter}`,
      tokenValue: -Math.round(usd * 0.3 * CREDITS_PER_USD),
    },
  ];
}

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  Transaction = mongoose.models.Transaction;
  TaskCostProfile = mongoose.models.TaskCostProfile;
  await Transaction.syncIndexes();
  await TaskCostProfile.syncIndexes();

  const app = express();
  app.get(
    '/api/bdren/task-costs',
    createProductKeyGuard(() => configuredKey),
    createTaskCostHandlers().getTaskCosts,
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  configuredKey = KEY;
  await Transaction.deleteMany({});
  await TaskCostProfile.deleteMany({});
});

describe('percentile', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20], 0.9)).toBeCloseTo(19, 9);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('computeTaskCostProfile', () => {
  /** The hand calculation, in USD, for ten Word requests. */
  const TEN = [0.01, 0.012, 0.015, 0.02, 0.022, 0.028, 0.03, 0.035, 0.05, 0.1];

  it('matches a hand calculation on ten seeded requests', async () => {
    await Transaction.insertMany(TEN.flatMap((usd) => request('word', usd)));

    await computeTaskCostProfile(NOW);

    const [row] = await TaskCostProfile.find({ taskType: 'word' }).lean();
    /** sorted: .010 .012 .015 .020 .022 .028 .030 .035 .050 .100  (n = 10)
     *  median = (5th + 6th) / 2 = (.022 + .028) / 2 = .025
     *  p90    = position 0.9 * 9 = 8.1 -> .050 + .1 * (.100 - .050) = .055
     *  mean   = .322 / 10 = .0322 */
    expect(row.requests).toBe(10);
    expect(row.medianUsd).toBeCloseTo(0.025, 6);
    expect(row.p90Usd).toBeCloseTo(0.055, 6);
    expect(row.meanUsd).toBeCloseTo(0.0322, 6);
    expect(row.day).toBe('2026-11-14');
    expect(row.sufficient).toBe(false);
  });

  it('counts a request once however many rows it wrote, and leaves out platform cost, old rows and untagged ones', async () => {
    const counted = request('chat', 0.01);
    await Transaction.insertMany([
      ...counted,
      ...request('chat', 0.02, { billable: false }),
      ...request('chat', 0.04, { createdAt: new Date('2026-10-01T00:00:00Z') }),
      ...request('chat', 0.08, { taskType: undefined }),
    ]);
    /** A web charge and a memory row on the first request's message id. */
    await Transaction.insertMany([
      {
        user,
        tokenType: 'credits',
        taskType: 'chat',
        service: 'firecrawl',
        billable: true,
        conversationId: 'c',
        rawAmount: 4,
        tokenValue: -Math.round(0.0152 * CREDITS_PER_USD),
        messageId: counted[0].messageId,
        requestKey: 'fc',
        createdAt: new Date('2026-11-10T04:00:01Z'),
      },
    ]);

    await computeTaskCostProfile(NOW);

    const [row] = await TaskCostProfile.find({}).lean();
    expect(row.requests).toBe(1);
    expect(row.meanUsd).toBeCloseTo(0.01 + 0.0152, 6);
    expect(row.avgWebCredits).toBe(4);
  });

  it('works out cost per scanned page and the extras a request carried', async () => {
    const first = request('scan_to_word', 0.03);
    const second = request('scan_to_word', 0.02);
    await Transaction.insertMany([
      ...first,
      {
        user,
        tokenType: 'credits',
        taskType: 'scan_to_word',
        messageId: first[0].messageId,
        service: 'unstructured',
        conversationId: 'c',
        billable: true,
        pages: 3,
        tokenValue: -Math.round(0.045 * CREDITS_PER_USD),
        requestKey: 'o1',
        createdAt: new Date('2026-11-10T04:00:02Z'),
      },
      ...second,
      {
        user,
        tokenType: 'credits',
        taskType: 'scan_to_word',
        messageId: second[0].messageId,
        service: 'unstructured',
        conversationId: 'c',
        billable: true,
        pages: 1,
        tokenValue: -Math.round(0.015 * CREDITS_PER_USD),
        requestKey: 'o2',
        createdAt: new Date('2026-11-10T04:00:02Z'),
      },
      ...request('image', 0.04, { context: 'image_generation' }),
    ]);

    await computeTaskCostProfile(NOW);

    const scan = await TaskCostProfile.findOne({ taskType: 'scan_to_word' }).lean();
    /** (0.03 + 0.045 + 0.02 + 0.015) / (3 + 1 pages) = 0.11 / 4 */
    expect(scan?.perPageUsd).toBeCloseTo(0.0275, 6);
    expect(scan?.avgPages).toBe(2);
    const image = await TaskCostProfile.findOne({ taskType: 'image' }).lean();
    expect(image?.avgImages).toBe(1);
  });

  it('replaces the day on a second run', async () => {
    await Transaction.insertMany(request('word', 0.01));
    await computeTaskCostProfile(NOW);
    await Transaction.deleteMany({});
    await Transaction.insertMany(request('excel', 0.02));
    await computeTaskCostProfile(NOW);

    const rows = await TaskCostProfile.find({}).lean();
    expect(rows.map((profile) => profile.taskType)).toEqual(['excel']);
  });

  it('builds a profile for any list of costs', () => {
    const profile = buildProfile('chat', '2026-11-14', [
      { usd: 0.02, pages: 0, webCredits: 0, images: 0 },
    ]);
    expect(profile).toMatchObject({
      requests: 1,
      medianUsd: 0.02,
      p90Usd: 0.02,
      sufficient: false,
    });
  });
});

describe('GET /api/bdren/task-costs', () => {
  it('refuses a request without the product key, with a wrong one, and when none is configured', async () => {
    expect((await get('/api/bdren/task-costs')).status).toBe(401);
    expect((await get('/api/bdren/task-costs', { 'x-product-key': 'nope' })).status).toBe(401);
    expect((await get('/api/bdren/task-costs', { authorization: 'Bearer nope' })).status).toBe(401);
    configuredKey = undefined;
    expect((await get('/api/bdren/task-costs', { 'x-product-key': KEY })).status).toBe(503);
    configuredKey = '';
    expect((await get('/api/bdren/task-costs', { authorization: 'Bearer ' })).status).toBe(503);
  });

  it('accepts the key as a bearer token or as X-Product-Key', async () => {
    expect((await get('/api/bdren/task-costs', { authorization: `Bearer ${KEY}` })).status).toBe(
      200,
    );
    expect((await get('/api/bdren/task-costs', { 'x-product-key': KEY })).status).toBe(200);
  });

  it('lists all thirteen task types as estimates before there is any data', async () => {
    const { status, body } = await get('/api/bdren/task-costs', { 'x-product-key': KEY });
    expect(status).toBe(200);
    expect(body.day).toBeNull();
    expect(body.taskTypes.map((entry: { taskType: string }) => entry.taskType)).toEqual([
      ...TASK_TYPES,
    ]);
    expect(
      body.taskTypes.every(
        (entry: { source: string; medianUsd: unknown }) =>
          entry.source === 'estimate' && entry.medianUsd === null,
      ),
    ).toBe(true);
  });

  it('serves measured numbers only for task types with at least 20 requests', async () => {
    const costs = Array.from({ length: 20 }, (_, index) => 0.01 + index * 0.001);
    await Transaction.insertMany([
      ...costs.flatMap((usd) => request('word', usd)),
      ...[0.01, 0.012, 0.015, 0.02, 0.022, 0.028, 0.03, 0.035, 0.05, 0.1].flatMap((usd) =>
        request('excel', usd),
      ),
    ]);
    await computeTaskCostProfile(NOW);

    const { body } = await get('/api/bdren/task-costs', { 'x-product-key': KEY });

    const byType = Object.fromEntries(
      body.taskTypes.map((entry: { taskType: string }) => [entry.taskType, entry]),
    );
    expect(body).toMatchObject({
      day: '2026-11-14',
      windowDays: 30,
      minRequests: 20,
      creditsPerUsd: 1_000_000,
    });
    expect(byType.word).toMatchObject({ source: 'measured', requests: 20 });
    expect(byType.word.medianUsd).toBeCloseTo(0.0195, 6);
    expect(byType.word.p90Usd).toBeCloseTo(0.0271, 6);
    expect(byType.word.medianCredits).toBe(19_500);
    expect(byType.excel).toMatchObject({ source: 'estimate', requests: 10, medianUsd: null });
    expect(byType.chat).toMatchObject({ source: 'estimate', requests: 0 });
  });

  it('adds the daily trend when asked', async () => {
    await TaskCostProfile.insertMany(
      ['2026-11-12', '2026-11-13', '2026-11-14'].map((day, index) => ({
        day,
        taskType: 'word',
        windowDays: 30,
        requests: 25,
        medianUsd: 0.02 + index * 0.001,
        p90Usd: 0.04,
        meanUsd: 0.03,
        sufficient: true,
      })),
    );
    expect(
      (await get('/api/bdren/task-costs', { 'x-product-key': KEY })).body.trend,
    ).toBeUndefined();

    const { body } = await get('/api/bdren/task-costs?history=2', { 'x-product-key': KEY });

    expect(body.trend.map((point: { day: string }) => point.day)).toEqual([
      '2026-11-13',
      '2026-11-14',
    ]);
  });

  it('serves the same data the helper returns', async () => {
    await Transaction.insertMany(request('word', 0.02));
    await computeTaskCostProfile(NOW);
    const { body } = await get('/api/bdren/task-costs', { 'x-product-key': KEY });
    expect(body).toEqual(JSON.parse(JSON.stringify(await getTaskCostProfile())));
  });
});
