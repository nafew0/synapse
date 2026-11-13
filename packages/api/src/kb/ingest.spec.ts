import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  runAsSystem,
  tenantStorage,
  KbDocumentStatuses,
} from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { KbIndexClient, KbIndexUpload, KbIndexTarget } from './rag';
import type { DoclingClient } from './docling';
import type { DoclingDocument } from './types';
import { processNextKbJob, type KbIngestDeps } from './ingest';
import contacts from './__fixtures__/contacts.docling.json';
import { DoclingRejectedError } from './docling';

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

const files = new Map<string, Buffer>();
const deleted: string[] = [];
const uploads: KbIndexUpload[] = [];
const activated: KbIndexTarget[] = [];

const index: KbIndexClient = {
  upload: async (input) => {
    uploads.push(input);
  },
  activate: async (target) => {
    activated.push(target);
  },
  remove: async () => undefined,
};

const docling = (convert: DoclingClient['convert']): DoclingClient => ({ convert });
const readsContacts = docling(async () => contacts as unknown as DoclingDocument);

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const deps = (client: DoclingClient): KbIngestDeps => ({
  methods,
  docling: client,
  index,
  readFile: async (fileRef) => {
    const buffer = files.get(fileRef);
    if (!buffer) {
      throw new Error(`missing ${fileRef}`);
    }
    return buffer;
  },
  deleteFile: async (fileRef) => {
    deleted.push(fileRef);
  },
  runAsSystem,
  runAsTenant: asTenant,
});

const upload = async (tenantId: string, n: number, mimeType = 'application/pdf', body = 'pdf') => {
  const fileRef = `kb/${tenantId}/${n}`;
  files.set(fileRef, Buffer.from(body));
  return {
    fileRef,
    filename: `file-${n}`,
    mimeType,
    sha256: `sha-${tenantId}-${n}`,
    sizeBytes: body.length,
  };
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

afterEach(async () => {
  files.clear();
  deleted.length = 0;
  uploads.length = 0;
  activated.length = 0;
  await Promise.all(
    ['KbDocument', 'KbDocumentVersion', 'KbIngestJob'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});

describe('processNextKbJob', () => {
  it('returns false when nothing is queued', async () => {
    expect(await processNextKbJob(deps(readsContacts))).toBe(false);
  });

  it('parses, uploads, activates and marks the document ready under its own tenant', async () => {
    const file = await upload('uni-a', 1);
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'BdREN contacts', docType: 'directory', file }),
    );

    expect(await processNextKbJob(deps(readsContacts))).toBe(true);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      tenantId: 'uni-a',
      documentId: String(document._id),
      version: 1,
      title: 'BdREN contacts',
      docType: 'directory',
    });
    expect(uploads[0].chunks.some((chunk) => chunk.text.includes('noc@bdren.net.bd'))).toBe(true);
    expect(activated).toEqual([
      { tenantId: 'uni-a', documentId: String(document._id), version: 1 },
    ]);

    const ready = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
    expect(ready).toMatchObject({
      status: KbDocumentStatuses.READY,
      currentVersion: 1,
      pageCount: 1,
      chunkCount: uploads[0].chunks.length,
      unreadablePages: [],
    });
  });

  it('indexes plain text without calling Docling', async () => {
    const file = await upload(
      'uni-a',
      1,
      'text/plain',
      'NOC email: noc@bdren.net.bd\n\nHours: 24/7',
    );
    await asTenant('uni-a', () => methods.createKbDocument({ title: 'Notes', file }));
    const convert = jest.fn();
    await processNextKbJob(deps(docling(convert)));
    expect(convert).not.toHaveBeenCalled();
    expect(uploads[0].chunks[0].text).toBe('NOC email: noc@bdren.net.bd\n\nHours: 24/7');
  });

  it('fails a scanned file with a clear reason and no retry', async () => {
    const file = await upload('uni-a', 1);
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Scan', file }),
    );
    const scanned = {
      ...contacts,
      body: { ...contacts.body, children: [] },
      pages: { 1: {}, 2: {} },
    };
    await processNextKbJob(deps(docling(async () => scanned as unknown as DoclingDocument)));

    expect(uploads).toHaveLength(0);
    const failed = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
    expect(failed?.status).toBe(KbDocumentStatuses.FAILED);
    expect(failed?.error).toMatch(/looks scanned/);
  });

  it('retries when Docling is down, but not when it rejects the file', async () => {
    const down = await upload('uni-a', 1);
    const bad = await upload('uni-b', 2);
    await asTenant('uni-a', () => methods.createKbDocument({ title: 'Down', file: down }));
    const { document } = await asTenant('uni-b', () =>
      methods.createKbDocument({ title: 'Bad', file: bad }),
    );

    await processNextKbJob(deps(docling(async () => Promise.reject(new Error('ECONNREFUSED')))));
    await processNextKbJob(
      deps(docling(async () => Promise.reject(new DoclingRejectedError('corrupt PDF')))),
    );

    const queued = await runAsSystem(() =>
      mongoose.models.KbIngestJob.find({}).sort({ tenantId: 1 }).lean(),
    );
    expect(queued.map((job) => [job.tenantId, job.status])).toEqual([
      ['uni-a', 'queued'],
      ['uni-b', 'failed'],
    ]);
    const rejected = await asTenant('uni-b', () => methods.getKbDocument(String(document._id)));
    expect(rejected).toMatchObject({ status: KbDocumentStatuses.FAILED, error: 'corrupt PDF' });
  });

  it('deletes the files of versions pruned after a new one is indexed', async () => {
    const first = await upload('uni-a', 1);
    const { document } = await asTenant('uni-a', () =>
      methods.createKbDocument({ title: 'Policy', file: first }),
    );
    await processNextKbJob(deps(readsContacts));
    for (let n = 2; n <= 6; n++) {
      const next = await upload('uni-a', n);
      await asTenant('uni-a', () => methods.addKbDocumentVersion(String(document._id), next));
      await processNextKbJob(deps(readsContacts));
    }
    expect(deleted).toEqual(['kb/uni-a/1']);
  });
});
