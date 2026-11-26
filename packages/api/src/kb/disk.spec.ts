import os from 'os';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  KbLimits,
  runAsSystem,
  createModels,
  createMethods,
  tenantStorage,
} from '@librechat/data-schemas';
import type { AllMethods, IKbStorageDaily } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import {
  firstDayOf,
  readKbStorage,
  readStorageDays,
  recordKbStorage,
  backfillKbStorage,
  snapshotKbStorage,
  createKbStorageHandlers,
  runDailyKbStorageSnapshot,
} from './disk';
import { createLocalKbFileStore } from './store';

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let root: string;

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

async function addDocument(tenantId: string, title: string, bytes: string) {
  const store = createLocalKbFileStore(root);
  const fileRef = await store.save({ tenantId, extension: '.txt', buffer: Buffer.from(bytes) });
  return asTenant(tenantId, () =>
    methods.createKbDocument({
      title,
      file: {
        fileRef,
        filename: `${title}.txt`,
        mimeType: 'text/plain',
        sha256: `${tenantId}-${title}`,
        sizeBytes: Buffer.byteLength(bytes),
      },
    }),
  );
}

async function addInstitution(tenantId: string, name: string) {
  await runAsSystem(() =>
    mongoose.models.Institution.create({ tenantId, name, slug: tenantId, status: 'active' }),
  );
}

const rows = () =>
  runAsSystem(() =>
    mongoose.models.KbStorageDaily.find({})
      .sort({ tenantId: 1, day: 1 })
      .lean<IKbStorageDaily[]>()
      .exec(),
  );

type Captured = { status: number; body: Record<string, unknown> };

const call = async (
  handler: (req: Request, res: Response) => Promise<void>,
  req: { query?: Record<string, string>; params?: Record<string, string> },
): Promise<Captured> => {
  const captured: Captured = { status: 200, body: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  };
  await handler(
    { query: {}, params: {}, ...req } as unknown as Request,
    res as unknown as Response,
  );
  return captured;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  methods = createMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-disk-'));
});

afterEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await runAsSystem(() =>
    Promise.all(
      [
        'KbDocument',
        'KbDocumentVersion',
        'KbIngestJob',
        'KbStorageDaily',
        'Institution',
        'UsageJob',
      ].map((name) => mongoose.models[name].deleteMany({})),
    ),
  );
});

describe('readStorageDays', () => {
  it('defaults to 90 and accepts whole numbers from 1 to 365 only', () => {
    expect(readStorageDays(undefined)).toBe(90);
    expect(readStorageDays('')).toBe(90);
    expect(readStorageDays('1')).toBe(1);
    expect(readStorageDays('365')).toBe(365);
    expect(readStorageDays('0')).toBeNull();
    expect(readStorageDays('366')).toBeNull();
    expect(readStorageDays('7.5')).toBeNull();
    expect(readStorageDays('abc')).toBeNull();
  });

  it('counts the window back from today in Asia/Dhaka', () => {
    const lateEvening = new Date('2026-11-20T18:30:00Z');
    expect(firstDayOf(1, lateEvening)).toBe('2026-11-21');
    expect(firstDayOf(3, lateEvening)).toBe('2026-11-19');
    expect(firstDayOf(1, new Date('2026-11-20T17:59:59Z'))).toBe('2026-11-20');
  });
});

describe('daily storage rows', () => {
  it('files a measurement under the Asia/Dhaka day, not the UTC one', async () => {
    await addDocument('uni-a', 'policy', 'abcd');
    await recordKbStorage(methods, 'uni-a', new Date('2026-11-20T17:59:00Z'));
    await recordKbStorage(methods, 'uni-a', new Date('2026-11-20T18:01:00Z'));
    expect((await rows()).map((row) => row.day)).toEqual(['2026-11-20', '2026-11-21']);
  });

  it('snapshots every institution and tenant once per day, each with its own figures', async () => {
    await addInstitution('uni-a', 'University A');
    await addInstitution('uni-empty', 'Empty College');
    await addDocument('uni-a', 'policy', 'abcdef');
    await addDocument('uni-b', 'rules', 'xyz');

    const morning = new Date('2026-11-21T03:00:00Z');
    expect(await runDailyKbStorageSnapshot(methods, morning)).toBe(true);
    expect(await runDailyKbStorageSnapshot(methods, new Date('2026-11-21T09:00:00Z'))).toBe(false);
    expect(
      (await rows()).map((row) => [row.tenantId, row.day, row.originalBytes, row.documents]),
    ).toEqual([
      ['uni-a', '2026-11-21', 6, 1],
      ['uni-b', '2026-11-21', 3, 1],
      ['uni-empty', '2026-11-21', 0, 0],
    ]);

    await snapshotKbStorage(methods, new Date('2026-11-21T04:00:00Z'));
    expect(await rows()).toHaveLength(3);

    expect(await runDailyKbStorageSnapshot(methods, new Date('2026-11-21T18:05:00Z'))).toBe(true);
    expect((await rows()).filter((row) => row.day === '2026-11-22')).toHaveLength(3);
  });

  it('gives the day back when the snapshot fails, so the next tick retries', async () => {
    const failing = {
      ...methods,
      measureKbStorage: () => Promise.reject(new Error('database down')),
    };
    const now = new Date('2026-11-21T03:00:00Z');
    await expect(runDailyKbStorageSnapshot(failing, now)).rejects.toThrow('database down');
    expect(await runDailyKbStorageSnapshot(methods, now)).toBe(true);
  });
});

describe('readKbStorage', () => {
  it('returns current figures with the limit and only that tenant’s days', async () => {
    await addDocument('uni-a', 'policy', 'abcdef');
    await addDocument('uni-b', 'rules', 'xyz');
    const now = new Date('2026-11-21T06:00:00Z');
    await recordKbStorage(methods, 'uni-a', new Date('2026-11-01T06:00:00Z'));
    await recordKbStorage(methods, 'uni-a', now);
    await recordKbStorage(methods, 'uni-b', now);

    const view = await readKbStorage(methods, 'uni-a', 7, now);
    expect(view.current).toEqual({
      documents: 1,
      versions: 1,
      originalBytes: 6,
      parsedBytes: 0,
      indexChunks: 0,
      totalBytes: 6,
      limitBytes: KbLimits.maxTotalBytes,
      measuredAt: now.toISOString(),
    });
    expect(view.daily).toEqual([
      {
        day: '2026-11-21',
        documents: 1,
        versions: 1,
        originalBytes: 6,
        parsedBytes: 0,
        totalBytes: 6,
      },
    ]);
    expect((await readKbStorage(methods, 'uni-a', 30, now)).daily).toHaveLength(2);
  });
});

describe('platform storage handlers', () => {
  const now = new Date('2026-11-21T06:00:00Z');
  const handlers = () => createKbStorageHandlers({ methods, now: () => now });

  it('lists every institution with its figures, trend and the platform totals', async () => {
    await addInstitution('uni-a', 'University A');
    await addInstitution('uni-empty', 'Empty College');
    await addDocument('uni-a', 'policy', 'abcdef');
    await addDocument('uni-a', 'rules', 'abcd');
    await recordKbStorage(methods, 'uni-a', new Date('2026-11-20T06:00:00Z'));
    await recordKbStorage(methods, 'uni-a', now);

    const listed = await call(handlers().list, { query: { days: '30' } });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      days: 30,
      limitBytes: KbLimits.maxTotalBytes,
      totals: { documents: 2, versions: 2, originalBytes: 10, totalBytes: 10 },
    });
    const institutions = listed.body.institutions as {
      tenantId: string;
      name: string;
      current: { totalBytes: number; documents: number };
      trend: { day: string; totalBytes: number }[];
    }[];
    expect(institutions.map((i) => [i.tenantId, i.name, i.current.totalBytes])).toEqual([
      ['uni-a', 'University A', 10],
      ['uni-empty', 'Empty College', 0],
    ]);
    expect(institutions[0].trend).toEqual([
      { day: '2026-11-20', totalBytes: 10 },
      { day: '2026-11-21', totalBytes: 10 },
    ]);
    expect((await call(handlers().list, { query: { days: '0' } })).status).toBe(400);
  });

  it('shows one institution’s series and 404s an unknown one', async () => {
    await addInstitution('uni-a', 'University A');
    await addDocument('uni-a', 'policy', 'abcdef');
    await recordKbStorage(methods, 'uni-a', now);
    const one = await call(handlers().institution, { params: { tenantId: 'uni-a' } });
    expect(one.body).toMatchObject({
      tenantId: 'uni-a',
      name: 'University A',
      days: 90,
      current: { totalBytes: 6, limitBytes: KbLimits.maxTotalBytes },
      daily: [{ day: '2026-11-21', totalBytes: 6 }],
    });
    expect((await call(handlers().institution, { params: { tenantId: 'nope' } })).status).toBe(404);
  });
});

describe('backfillKbStorage', () => {
  it('corrects recorded sizes from the files, reports missing ones and writes the day', async () => {
    const store = createLocalKbFileStore(root);
    const { document } = await addDocument('uni-a', 'policy', 'abcdef');
    await addDocument('uni-a', 'gone', 'xyz');
    const versions = await runAsSystem(() =>
      mongoose.models.KbDocumentVersion.find({})
        .sort({ createdAt: 1 })
        .lean<{ fileRef: string }[]>(),
    );
    await runAsSystem(() =>
      Promise.all([
        mongoose.models.KbDocumentVersion.updateOne(
          { documentId: document._id },
          { $set: { sizeBytes: 0, indexedAt: new Date() } },
        ),
        mongoose.models.KbDocument.updateOne(
          { _id: document._id },
          { $set: { sizeBytes: 0, currentVersion: 1 } },
        ),
      ]),
    );
    fs.rmSync(path.join(root, versions[1].fileRef));

    const dry = await backfillKbStorage({ methods, store, dryRun: true });
    expect(dry).toMatchObject({ versions: 2, corrected: 1, unmeasuredVersions: 1, tenants: 0 });
    expect(await rows()).toHaveLength(0);

    const now = new Date('2026-11-21T06:00:00Z');
    const result = await backfillKbStorage({ methods, store, now });
    expect(result).toMatchObject({
      versions: 2,
      corrected: 1,
      missing: [{ tenantId: 'uni-a', fileRef: versions[1].fileRef }],
      tenants: 1,
    });
    const fixed = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
    expect(fixed?.sizeBytes).toBe(6);
    expect(await rows()).toEqual([
      expect.objectContaining({ tenantId: 'uni-a', day: '2026-11-21', originalBytes: 9 }),
    ]);
  });
});
