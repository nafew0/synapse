import os from 'os';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, KbLimits, tenantStorage } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createLocalKbFileStore } from '~/kb/store';
import { createAdminKbHandlers } from './kb';

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let root: string;
const removed: { tenantId: string; documentId: string }[] = [];

type Captured = { status: number; body: unknown };

const call = async (
  handler: (req: Request, res: Response) => Promise<void>,
  req: Record<string, unknown>,
): Promise<Captured> => {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  await handler(
    {
      params: {},
      body: {},
      user: { id: '64b000000000000000000001' },
      ...req,
    } as unknown as Request,
    res as unknown as Response,
  );
  return captured;
};

const upload = (name: string, body = 'NOC email: noc@bdren.net.bd') => ({
  buffer: Buffer.from(body),
  originalname: Buffer.from(name, 'utf8').toString('latin1'),
  size: Buffer.byteLength(body),
});

const handlersFor = (tenantId: string | null) =>
  createAdminKbHandlers({
    methods,
    store: createLocalKbFileStore(root),
    index: { remove: async (target) => void removed.push(target) },
    resolveTenant: (_req, res) => {
      if (!tenantId) {
        res.status(400).json({ error: 'Select an institution to scope this request' });
      }
      return tenantId;
    },
  });

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-admin-'));
  removed.length = 0;
});

afterEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await Promise.all(
    ['KbDocument', 'KbDocumentVersion', 'KbIngestJob'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});

describe('admin knowledge base handlers', () => {
  it('stores an upload, queues it and lists it with usage and limits', async () => {
    const kb = handlersFor('uni-a');
    const created = await call(kb.upload, {
      file: upload('যোগাযোগ তালিকা.txt'),
      body: { docType: 'directory' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      document: {
        title: 'যোগাযোগ তালিকা',
        filename: 'যোগাযোগ তালিকা.txt',
        mimeType: 'text/plain',
        docType: 'directory',
        status: 'queued',
      },
    });

    const listed = await call(kb.list, {});
    expect(listed.body).toMatchObject({
      usage: { documents: 1, bytes: 27 },
      limits: { maxDocuments: KbLimits.maxDocuments },
    });
    const versions = await tenantStorage.run({ tenantId: 'uni-a' }, async () =>
      mongoose.models.KbDocumentVersion.find({}).lean(),
    );
    expect(fs.readFileSync(path.join(root, versions[0].fileRef), 'utf8')).toBe(
      'NOC email: noc@bdren.net.bd',
    );
    const job = await mongoose.models.KbIngestJob.findOne({}).lean();
    expect(job).toMatchObject({ tenantId: 'uni-a', status: 'queued' });
  });

  it('rejects unsupported types, empty files and unknown document types', async () => {
    const kb = handlersFor('uni-a');
    expect((await call(kb.upload, { file: upload('run.exe') })).status).toBe(400);
    expect((await call(kb.upload, { file: upload('empty.txt', '') })).status).toBe(400);
    expect((await call(kb.upload, {})).status).toBe(400);
    expect(
      (await call(kb.upload, { file: upload('a.txt'), body: { docType: 'secret' } })).status,
    ).toBe(400);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses uploads past the document limit', async () => {
    const kb = handlersFor('uni-a');
    await tenantStorage.run({ tenantId: 'uni-a' }, async () => {
      for (let n = 0; n < KbLimits.maxDocuments; n++) {
        await methods.createKbDocument({
          title: `Doc ${n}`,
          file: {
            fileRef: `kb/x/${n}`,
            filename: 'x.txt',
            mimeType: 'text/plain',
            sha256: `s${n}`,
            sizeBytes: 1,
          },
        });
      }
    });
    const refused = await call(kb.upload, { file: upload('one-more.txt') });
    expect(refused.status).toBe(409);
  });

  it('replaces a document with a new version and refuses the same file twice', async () => {
    const kb = handlersFor('uni-a');
    const created = await call(kb.upload, { file: upload('policy.txt') });
    const id = (created.body as { document: { id: string } }).document.id;

    const again = await call(kb.replace, {
      params: { documentId: id },
      file: upload('policy.txt'),
    });
    expect(again.status).toBe(409);

    const replaced = await call(kb.replace, {
      params: { documentId: id },
      file: upload('policy-v2.txt', 'Leave: twenty days'),
    });
    expect(replaced.body).toMatchObject({ document: { latestVersion: 2, status: 'queued' } });
    const versions = await call(kb.versions, { params: { documentId: id } });
    expect(
      (versions.body as { versions: { version: number }[] }).versions.map((v) => v.version),
    ).toEqual([2, 1]);
  });

  it('renames a document and rejects an empty title', async () => {
    const kb = handlersFor('uni-a');
    const created = await call(kb.upload, { file: upload('policy.txt') });
    const id = (created.body as { document: { id: string } }).document.id;
    expect(
      (await call(kb.update, { params: { documentId: id }, body: { title: ' ' } })).status,
    ).toBe(400);
    const renamed = await call(kb.update, {
      params: { documentId: id },
      body: { title: 'HR policy', docType: 'policy' },
    });
    expect(renamed.body).toMatchObject({ document: { title: 'HR policy', docType: 'policy' } });
  });

  it('deletes a document, its files and its index chunks', async () => {
    const kb = handlersFor('uni-a');
    const created = await call(kb.upload, { file: upload('policy.txt') });
    const id = (created.body as { document: { id: string } }).document.id;
    const deleted = await call(kb.remove, { params: { documentId: id } });
    expect(deleted.status).toBe(204);
    expect(removed).toEqual([{ tenantId: 'uni-a', documentId: id }]);
    const left = fs.readdirSync(path.join(root, 'kb'), { recursive: true });
    expect(left.filter((entry) => String(entry).includes('.'))).toEqual([]);
  });

  it('never reaches another institution’s document', async () => {
    const created = await call(handlersFor('uni-a').upload, { file: upload('policy.txt') });
    const id = (created.body as { document: { id: string } }).document.id;
    const other = handlersFor('uni-b');
    expect((await call(other.remove, { params: { documentId: id } })).status).toBe(404);
    expect((await call(other.list, {})).body).toMatchObject({ documents: [] });
  });

  it('asks a superadmin to pick an institution first', async () => {
    const result = await call(handlersFor(null).list, {});
    expect(result.status).toBe(400);
  });
});
