import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { KbFileInput } from './kb';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { KbLimits, KbDocumentStatuses, KbIngestJobStatuses } from '~/common';
import { createKbMethods, type KbMethods } from './kb';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let methods: KbMethods;
let modelsToCleanup: string[] = [];

const parser = { name: 'docling-serve', version: '1.38.2' };

const file = (n: number, sizeBytes = 1000): KbFileInput => ({
  fileRef: `kb/file-${n}.pdf`,
  filename: `handbook-${n}.pdf`,
  mimeType: 'application/pdf',
  sha256: `sha-${n}`,
  sizeBytes,
});

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const claim = () => runAsSystem(() => methods.claimKbIngestJob());

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  methods = createKbMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const name of modelsToCleanup) {
    delete mongoose.models[name];
  }
});

afterEach(async () => {
  await Promise.all(
    ['KbDocument', 'KbDocumentVersion', 'KbIngestJob'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});

describe('knowledge base documents', () => {
  it('queues the first version and makes it current once indexed', async () => {
    const { document, job } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'HR policy', file: file(1) }),
    );
    expect(document.tenantId).toBe('uni-a');
    expect(document.status).toBe(KbDocumentStatuses.QUEUED);
    expect(job.version).toBe(1);

    const claimed = await claim();
    expect(claimed?.status).toBe(KbIngestJobStatuses.PROCESSING);
    expect(claimed?.attempts).toBe(1);

    await asTenant('uni-a', () =>
      methods.completeKbIngestJob({
        jobId: claimed!._id,
        pageCount: 12,
        chunkCount: 40,
        unreadablePages: [3],
        parser,
      }),
    );
    const ready = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
    expect(ready).toMatchObject({
      status: KbDocumentStatuses.READY,
      currentVersion: 1,
      pageCount: 12,
      chunkCount: 40,
      unreadablePages: [3],
    });
    const version = await asTenant('uni-a', () =>
      methods.getKbDocumentVersion(String(document._id), 1),
    );
    expect(version?.indexedAt).toBeInstanceOf(Date);
    expect(version?.parser).toMatchObject(parser);
  });

  it('keeps one institution from seeing another institution’s documents', async () => {
    await asTenant('uni-a', () => methods.createKbDocument({ title: 'A', file: file(1) }));
    await asTenant('uni-b', () => methods.createKbDocument({ title: 'B', file: file(2) }));

    const listed = await asTenant('uni-b', () => methods.listKbDocuments());
    expect(listed.map((d) => d.title)).toEqual(['B']);
    expect(await asTenant('uni-b', () => methods.getKbUsage())).toEqual({
      documents: 1,
      bytes: 1000,
    });
  });

  it('refuses a new version identical to the latest one', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    await expect(
      asTenant('uni-a', () => methods.addKbDocumentVersion(String(document._id), file(1))),
    ).rejects.toThrow('same as the latest version');
  });

  it('keeps the old version current until the new one is indexed', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    const first = await claim();
    await asTenant('uni-a', () =>
      methods.completeKbIngestJob({
        jobId: first!._id,
        pageCount: 1,
        chunkCount: 1,
        unreadablePages: [],
        parser,
      }),
    );

    const id = String(document._id);
    await asTenant('uni-a', () => methods.addKbDocumentVersion(id, file(2, 2000)));
    const pending = await asTenant('uni-a', () => methods.getKbDocument(id));
    expect(pending).toMatchObject({
      currentVersion: 1,
      latestVersion: 2,
      status: KbDocumentStatuses.QUEUED,
      sizeBytes: 2000,
    });

    const second = await claim();
    expect(second?.version).toBe(2);
    await asTenant('uni-a', () =>
      methods.completeKbIngestJob({
        jobId: second!._id,
        pageCount: 2,
        chunkCount: 3,
        unreadablePages: [],
        parser,
      }),
    );
    expect(await asTenant('uni-a', () => methods.getKbDocument(id))).toMatchObject({
      currentVersion: 2,
      status: KbDocumentStatuses.READY,
    });
  });

  it('keeps only the newest versions and returns the files to delete', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    const id = String(document._id);
    let pruned: string[] = [];
    for (let n = 1; n <= KbLimits.maxVersionsKept + 2; n++) {
      if (n > 1) {
        await asTenant('uni-a', () => methods.addKbDocumentVersion(id, file(n)));
      }
      const job = await claim();
      const result = await asTenant('uni-a', () =>
        methods.completeKbIngestJob({
          jobId: job!._id,
          pageCount: 1,
          chunkCount: 1,
          unreadablePages: [],
          parser,
        }),
      );
      pruned = pruned.concat(result.prunedFileRefs);
    }
    expect(pruned).toEqual(['kb/file-1.pdf', 'kb/file-2.pdf']);
    const kept = await asTenant('uni-a', () => methods.getKbDocumentVersion(id, 3));
    expect(kept?.fileRef).toBe('kb/file-3.pdf');
  });

  it('retries a failed job, then marks the document failed', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    let now = new Date();
    for (let attempt = 1; attempt <= KbLimits.maxIngestAttempts; attempt++) {
      const job = await runAsSystem(() => methods.claimKbIngestJob(now));
      expect(job?.attempts).toBe(attempt);
      const { retrying } = await asTenant('uni-a', () =>
        methods.failKbIngestJob({ jobId: job!._id, error: 'parser timed out', now }),
      );
      expect(retrying).toBe(attempt < KbLimits.maxIngestAttempts);
      if (retrying) {
        expect(
          await asTenant('uni-a', () => methods.getKbDocument(String(document._id))),
        ).toMatchObject({ status: KbDocumentStatuses.QUEUED, error: 'Retrying: parser timed out' });
      }
      expect(await runAsSystem(() => methods.claimKbIngestJob(now))).toBeNull();
      now = new Date(now.getTime() + 60 * 60_000);
    }
    expect(
      await asTenant('uni-a', () => methods.getKbDocument(String(document._id))),
    ).toMatchObject({ status: KbDocumentStatuses.FAILED, error: 'parser timed out' });
  });

  it('leaves a live document ready when only its new version fails', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    const first = await claim();
    await asTenant('uni-a', () =>
      methods.completeKbIngestJob({
        jobId: first!._id,
        pageCount: 1,
        chunkCount: 1,
        unreadablePages: [],
        parser,
      }),
    );
    const id = String(document._id);
    await asTenant('uni-a', () => methods.addKbDocumentVersion(id, file(2)));
    const second = await claim();
    await asTenant('uni-a', () =>
      methods.failKbIngestJob({ jobId: second!._id, error: 'not a PDF', retryable: false }),
    );
    expect(await asTenant('uni-a', () => methods.getKbDocument(id))).toMatchObject({
      status: KbDocumentStatuses.READY,
      currentVersion: 1,
      error: 'Version 2 failed: not a PDF',
    });
  });

  it('reclaims a job abandoned mid-processing', async () => {
    await asTenant('uni-a', () => methods.createKbDocument({ title: 'Policy', file: file(1) }));
    const start = new Date();
    expect(await runAsSystem(() => methods.claimKbIngestJob(start))).not.toBeNull();
    const later = new Date(start.getTime() + KbLimits.ingestLeaseMs + 1);
    const reclaimed = await runAsSystem(() => methods.claimKbIngestJob(later));
    expect(reclaimed?.attempts).toBe(2);
  });

  it('deletes a document with all its versions and returns their files', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    const id = String(document._id);
    await asTenant('uni-a', () => methods.addKbDocumentVersion(id, file(2)));
    const { fileRefs } = await asTenant('uni-a', () => methods.deleteKbDocument(id));
    expect(fileRefs.sort()).toEqual(['kb/file-1.pdf', 'kb/file-2.pdf']);
    expect(await asTenant('uni-a', () => methods.getKbDocument(id))).toBeNull();
    expect(await claim()).toBeNull();
  });

  it('reports whether a tenant has anything searchable yet', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: file(1) }),
    );
    expect(await asTenant('uni-a', () => methods.hasReadyKbDocuments('uni-a'))).toBe(false);
    const job = await claim();
    await asTenant('uni-a', () =>
      methods.completeKbIngestJob({
        jobId: job!._id,
        pageCount: 1,
        chunkCount: 1,
        unreadablePages: [],
        parser,
      }),
    );
    expect(await asTenant('uni-a', () => methods.hasReadyKbDocuments('uni-a'))).toBe(true);
    expect(await asTenant('uni-b', () => methods.hasReadyKbDocuments('uni-b'))).toBe(false);

    const renamed = await asTenant('uni-a', () =>
      methods.updateKbDocument(String(document._id), {
        title: '  HR policy 2026 ',
        docType: 'policy',
      }),
    );
    expect(renamed).toMatchObject({ title: 'HR policy 2026', docType: 'policy' });
    const versions = await asTenant('uni-a', () =>
      methods.listKbDocumentVersions(String(document._id)),
    );
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  it('queues a failed version again on retry, and only a failed one', async () => {
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Scan', file: file(1) }),
    );
    const id = String(document._id);
    expect(await asTenant('uni-a', () => methods.retryKbDocument(id))).toBeNull();
    const job = await claim();
    await asTenant('uni-a', () =>
      methods.failKbIngestJob({ jobId: job!._id, error: 'looks scanned', retryable: false }),
    );
    const retried = await asTenant('uni-a', () => methods.retryKbDocument(id));
    expect(retried).toMatchObject({ status: KbDocumentStatuses.QUEUED, error: null });
    const again = await claim();
    expect(again).toMatchObject({ version: 1, attempts: 1 });
  });
});
