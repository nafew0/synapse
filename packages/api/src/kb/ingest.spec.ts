import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
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
import type { UnstructuredElement } from '~/files/unstructured/types';
import type { KbIngestOcr } from './ingest';
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

const upload = async (
  tenantId: string,
  n: number,
  mimeType = 'application/pdf',
  body: string | Buffer = 'pdf',
) => {
  const fileRef = `kb/${tenantId}/${n}`;
  files.set(fileRef, Buffer.isBuffer(body) ? body : Buffer.from(body));
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
    expect(failed?.error).toMatch(/is a scan .*cannot be read on this server/);
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

  describe('scanned pages', () => {
    /** Docling read page 1 only; page 2 is a scan. */
    const halfScanned = {
      ...contacts,
      pages: { 1: {}, 2: {} },
    } as unknown as DoclingDocument;

    const twoPagePdf = async (): Promise<Buffer> => {
      const pdf = await PDFDocument.create();
      pdf.addPage();
      pdf.addPage();
      return Buffer.from(await pdf.save());
    };

    const ocrElements: UnstructuredElement[] = [
      { type: 'Title', text: 'পরিচালক তালিকা', metadata: { page_number: 1 } },
      {
        type: 'Table',
        text: 'Office Email',
        metadata: {
          page_number: 1,
          text_as_html:
            '<table><tr><th>দপ্তর</th><th>ইমেইল</th></tr><tr><td>আইসিটি</td><td>ict@ugc.gov.bd</td></tr></table>',
        },
      },
    ];

    const ocr = (allowed: boolean) => {
      const charges: { pages: number; tenantId: string }[] = [];
      const sent: number[][] = [];
      const reader: KbIngestOcr = {
        maxPages: 50,
        allowed: async () => allowed,
        partition: async (file) => {
          const pdf = await PDFDocument.load(file.buffer);
          sent.push([pdf.getPageCount()]);
          return ocrElements;
        },
        recordCharge: async (charge) => void charges.push(charge),
      };
      return { reader, charges, sent };
    };

    it('reads only the scanned page with OCR, merges it in page order and records the charge', async () => {
      const file = await upload('uni-a', 1, 'application/pdf', await twoPagePdf());
      const { document } = await asTenant('uni-a', () =>
        methods.createKbDocument({ title: 'Mixed', file }),
      );
      const { reader, charges, sent } = ocr(true);
      await processNextKbJob({
        ...deps(docling(async () => halfScanned)),
        ocr: reader,
        classifyPages: async () => ['text', 'scan'],
      });

      expect(sent).toEqual([[1]]);
      expect(charges).toMatchObject([{ tenantId: 'uni-a', pages: 1 }]);
      const texts = uploads[0].chunks.map((chunk) => chunk.text);
      expect(texts.some((text) => text.includes('noc@bdren.net.bd'))).toBe(true);
      const ocrTable = uploads[0].chunks.find((chunk) => chunk.text.includes('ict@ugc.gov.bd'));
      expect(ocrTable).toMatchObject({
        kind: 'table',
        pageStart: 2,
        sectionPath: 'পরিচালক তালিকা',
      });
      expect(ocrTable?.text.startsWith('| দপ্তর | ইমেইল |')).toBe(true);
      const ready = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
      expect(ready).toMatchObject({ status: 'ready', pageCount: 2, unreadablePages: [] });
    });

    it('explains that OCR is off for the institution instead of indexing nothing', async () => {
      const file = await upload('uni-a', 1, 'application/pdf', await twoPagePdf());
      const { document } = await asTenant('uni-a', () =>
        methods.createKbDocument({ title: 'Scan', file }),
      );
      const scanned = {
        ...contacts,
        body: { ...contacts.body, children: [] },
        pages: { 1: {}, 2: {} },
      };
      const { reader, charges } = ocr(false);
      await processNextKbJob({
        ...deps(docling(async () => scanned as unknown as DoclingDocument)),
        ocr: reader,
        classifyPages: async () => ['scan', 'scan'],
      });
      expect(charges).toEqual([]);
      const failed = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
      expect(failed?.error).toMatch(/OCR\), which is off for this institution/);
    });

    it('never indexes a garbled text layer, and keeps it unreadable when OCR is off', async () => {
      const file = await upload('uni-a', 1, 'application/pdf', await twoPagePdf());
      const { document } = await asTenant('uni-a', () =>
        methods.createKbDocument({ title: 'Bijoy', file }),
      );
      const { reader } = ocr(false);
      await processNextKbJob({
        ...deps(docling(async () => halfScanned)),
        ocr: reader,
        classifyPages: async () => ['garbled', 'text'],
      });
      const failed = await asTenant('uni-a', () => methods.getKbDocument(String(document._id)));
      expect(uploads).toHaveLength(0);
      expect(failed?.status).toBe('failed');
    });
  });
});
