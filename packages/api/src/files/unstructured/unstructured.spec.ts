import http from 'http';
import { PDFDocument } from 'pdf-lib';
import type { AddressInfo } from 'net';
import type { DocumentReadDeps, DocumentReading } from './tool';
import type { UnstructuredElement } from './types';
import { buildDocumentReadContext, createDocumentReadTool, isDocumentOcrAllowed } from './tool';
import { createLimiter, createUnstructuredClient } from './client';
import { elementsToMarkdown, mergePages } from './merge';
import { subsetPdf } from './pages';

jest.mock('../scan/read', () => ({
  readPdfPages: jest.fn(async () => ({
    texts: ['typed first page', '', 'garbage'],
    kinds: ['text', 'scan', 'garbled'],
  })),
}));

const elements: UnstructuredElement[] = [
  { type: 'Title', text: 'অফিস আদেশ', metadata: { page_number: 1 } },
];

interface FakeParse {
  /** Answer the first request with 202, then these statuses when polled; the last repeats. */
  polled?: string[];
  rateLimited?: number;
  serverError?: boolean;
}

/** A local stand-in for Unstructured's documented Parse endpoints, so real HTTP is exercised. */
function startFake(job: FakeParse) {
  const seen: { method: string; url: string; key?: string; prefer?: string; body: string }[] = [];
  let polls = 0;
  let limited = job.rateLimited ?? 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({
        url,
        method: req.method ?? '',
        key: req.headers['unstructured-api-key'] as string,
        prefer: req.headers.prefer as string,
        body: Buffer.concat(chunks).toString('latin1'),
      });
      const send = (status: number, body: unknown, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url.startsWith('/api/v2/parse')) {
        if (limited-- > 0) {
          return send(429, { detail: 'slow down' });
        }
        if (job.serverError) {
          return send(400, { detail: 'bad file' });
        }
        if (job.polled) {
          return send(202, { id: 'job-1', status: 'queued' }, { location: '/api/v2/jobs/job-1' });
        }
        return send(200, { id: 'job-1', status: 'completed', elements });
      }
      if (url === '/api/v2/jobs/job-1' && job.polled) {
        const status = job.polled[Math.min(polls++, job.polled.length - 1)];
        return send(200, {
          status,
          result: status === 'completed' ? { id: 'job-1', status, elements } : null,
        });
      }
      if (url === '/api/v2/jobs/job-1/cancel') {
        return send(200, {});
      }
      return send(404, {});
    });
  });
  return new Promise<{ server: http.Server; seen: typeof seen; apiUrl: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, seen, apiUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

describe('Unstructured client', () => {
  const servers: http.Server[] = [];
  const clientFor = async (job: FakeParse, timeoutMs = 2_000) => {
    const fake = await startFake(job);
    servers.push(fake.server);
    const client = createUnstructuredClient({
      apiUrl: fake.apiUrl,
      apiKey: 'test-key',
      profile: 'best',
      concurrency: 5,
      timeoutMs,
      pollMinMs: 5,
      pollMaxMs: 10,
    });
    return { client, seen: fake.seen };
  };
  const file = { buffer: Buffer.from('%PDF'), filename: 'a.pdf', type: 'application/pdf' };

  afterAll(() => servers.forEach((server) => server.close()));

  it('asks for elements with coordinates and table HTML on the best profile', async () => {
    const { client, seen } = await clientFor({});
    await expect(client.partition(file)).resolves.toEqual(elements);
    expect(seen[0].url).toBe('/api/v2/parse?include=coordinates&include=table_html');
    expect(seen[0].key).toBe('test-key');
    expect(seen[0].prefer).toMatch(/^wait=\d+$/);
    expect(seen[0].body).toMatch(/name="profile"\r\n\r\nbest/);
    expect(seen[0].body).toMatch(/name="output"\r\n\r\nelements/);
    expect(seen[0].body).toContain('name="input"; filename="a.pdf"');
  });

  it('follows a job when the first request runs out of time', async () => {
    const { client, seen } = await clientFor({ polled: ['queued', 'processing', 'completed'] });
    await expect(client.partition(file)).resolves.toEqual(elements);
    expect(seen.filter((r) => r.url === '/api/v2/jobs/job-1')).toHaveLength(3);
  });

  it.each(['failed', 'cancelled'])('throws when a job ends %s', async (status) => {
    const { client } = await clientFor({ polled: [status] });
    await expect(client.partition(file)).rejects.toThrow(status);
  });

  it('does not retry a rejected file', async () => {
    const { client, seen } = await clientFor({ serverError: true });
    await expect(client.partition(file)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('retries a rate limit', async () => {
    const { client, seen } = await clientFor({ rateLimited: 1 });
    await expect(client.partition(file)).resolves.toEqual(elements);
    expect(seen).toHaveLength(2);
  });

  it('cancels a job that runs past the timeout', async () => {
    const { client, seen } = await clientFor({ polled: ['processing'] }, 30);
    await expect(client.partition(file)).rejects.toThrow('timed out');
    expect(seen.some((r) => r.url.endsWith('/cancel'))).toBe(true);
  });

  it('never runs more jobs at once than the limit', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limit(async () => {
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('subsetPdf', () => {
  it('copies only the chosen pages, in order', async () => {
    const source = await PDFDocument.create();
    [100, 200, 300].forEach((width) => source.addPage([width, 100]));
    const subset = await PDFDocument.load(await subsetPdf(await source.save(), [3, 1]));
    expect(subset.getPages().map((page) => page.getWidth())).toEqual([300, 100]);
  });
});

describe('merge', () => {
  it('maps OCR pages back and fills the rest from the parser', () => {
    const merged = mergePages({
      ocrPages: [2],
      texts: ['typed page', 'damaged layer', 'more typing'],
      ocrElements: [
        { type: 'Title', text: 'স্ক্যান', metadata: { page_number: 1, image_base64: 'AAAA' } },
      ],
    });
    expect(merged.map((e) => [e.metadata?.page_number, e.type, e.metadata?.source])).toEqual([
      [1, 'NarrativeText', 'parser'],
      [2, 'Title', undefined],
      [3, 'NarrativeText', 'parser'],
    ]);
    expect(merged[1].metadata).not.toHaveProperty('image_base64');
    expect(merged.map((e) => e.text)).not.toContain('damaged layer');
  });

  it('repairs the Khmer sign the model writes for a Bangla visarga', () => {
    const [element] = mergePages({
      ocrPages: [1],
      texts: [],
      ocrElements: [{ type: 'Title', text: '\u17d6 তথ্য \u17d6', metadata: { page_number: 1 } }],
    });
    expect(element.text).toBe('ঃ তথ্য ঃ');
  });

  it('renders headings, lists and table HTML', () => {
    const markdown = elementsToMarkdown([
      { type: 'Title', text: 'শিরোনাম', metadata: { page_number: 1, category_depth: 1 } },
      { type: 'ListItem', text: 'এক', metadata: { page_number: 1 } },
      { type: 'Table', text: 'x', metadata: { page_number: 2, text_as_html: '<table></table>' } },
      { type: 'PageBreak' },
    ]);
    expect(markdown).toBe(
      '<!-- page 1 -->\n\n## শিরোনাম\n\n- এক\n\n<!-- page 2 -->\n\n<table></table>',
    );
  });
});

describe('buildDocumentReadContext', () => {
  it('sends a digital PDF with damaged text to the free repair, but not a scan', () => {
    const context = buildDocumentReadContext([
      {
        file_id: 'a',
        filename: 'digital.pdf',
        metadata: { preparation: { scan: { ocrPages: [1, 2], garbledPages: [1, 2] } } },
      },
      {
        file_id: 'b',
        filename: 'mixed.pdf',
        metadata: { preparation: { scan: { ocrPages: [1, 2], garbledPages: [1] } } },
      },
    ]);
    expect(context).toContain('Exception: "digital.pdf" are digital PDFs');
    expect(context).not.toContain('Exception: "mixed.pdf"');
  });

  const scanned = (file_id: string, filename: string, ocrPages: number[]) => ({
    file_id,
    filename,
    metadata: { preparation: { scan: { ocrPages } } },
  });

  it('names each file once with its pages', () => {
    const file = scanned('a', 'order.pdf', [2, 5]);
    const context = buildDocumentReadContext([file, file, scanned('b', 'typed.pdf', []), {}]);
    expect(context).toContain('- "order.pdf": pages 2, 5');
    expect(context?.match(/order\.pdf/g)).toHaveLength(1);
    expect(context).not.toContain('typed.pdf');
  });

  it('names an attached image, which has no pages classified at upload', () => {
    /* A photographed office order reached the model as a picture with no name, so the model
     * could not call read_document and typed the order out by eye. */
    const context = buildDocumentReadContext([
      { file_id: 'i', filename: 'office-order.jpg', type: 'image/png' },
      { file_id: 'w', filename: 'sticker.webp', type: 'image/webp' },
    ]);
    expect(context).toContain('- "office-order.jpg"');
    expect(context).toContain('read_document');
    expect(context).not.toContain('sticker.webp');
  });

  it('keeps an image the model can see out of OCR unless its page is to be rebuilt or copied out', () => {
    /* A photographed maths question with "solve it" went to read_document, because the note
     * said to call it for anything done with an attached image; the model can read the picture. */
    const context = buildDocumentReadContext([
      { file_id: 'q', filename: 'question.png', type: 'image/png' },
    ]);
    expect(context).toContain('turned into a document');
    expect(context).toContain('read the picture yourself');
    expect(context).not.toContain('anything done');
    const scanned = buildDocumentReadContext([
      {
        file_id: 's',
        filename: 'scan.pdf',
        metadata: { preparation: { scan: { ocrPages: [1], garbledPages: [] } } },
      },
    ]);
    expect(scanned).toContain(
      'When the user wants anything done with one of them, call read_document',
    );
  });

  it('says nothing when no file needs OCR', () => {
    expect(buildDocumentReadContext([scanned('b', 'typed.pdf', []), {}])).toBeUndefined();
  });
});

describe('isDocumentOcrAllowed', () => {
  const config = {
    apiUrl: 'https://x',
    apiKey: 'k',
    profile: 'best' as const,
    maxPages: 50,
    concurrency: 5,
    agents: ['agent_office_assistant'],
    pricePerPageUsd: 0.015,
  };

  it('needs the assistant listed and the institution switched on', () => {
    const allowed = { config, ocrAccess: true, agentId: 'agent_office_assistant' };
    expect(isDocumentOcrAllowed(allowed)).toBe(true);
    expect(isDocumentOcrAllowed({ ...allowed, agentId: 'other' })).toBe(false);
    expect(isDocumentOcrAllowed({ ...allowed, ocrAccess: false })).toBe(false);
    expect(isDocumentOcrAllowed({ ...allowed, ocrAccess: undefined })).toBe(false);
    expect(isDocumentOcrAllowed({ ...allowed, config: undefined })).toBe(false);
  });
});

describe('read_document', () => {
  const pdf = { file_id: 'abcdef123456', filename: 'order.pdf', type: 'application/pdf' };
  const png = { file_id: 'fedcba654321', filename: 'photo.png', type: 'image/png' };

  const build = (overrides: Partial<DocumentReadDeps> = {}) => {
    const cache = new Map<string, DocumentReading>();
    const uploads: Record<string, string> = {};
    const partition = jest.fn(async () => [
      { type: 'Title', text: 'OCR title', metadata: { page_number: 1 } },
      { type: 'NarrativeText', text: 'OCR body', metadata: { page_number: 2 } },
    ]);
    const recordCharge = jest.fn(async () => undefined);
    const deps: DocumentReadDeps = {
      client: { partition },
      maxPages: 50,
      listFiles: async () => [pdf, png],
      readBytes: async () => Buffer.from('bytes'),
      getCached: async (key) => cache.get(key),
      setCached: async (key, value) => void cache.set(key, value),
      recordCharge,
      uploadToSandbox: async (name, content) => {
        uploads[name] = content;
        return { id: `id-${name}`, name, storage_session_id: 'storage-1', kind: 'user' };
      },
      ...overrides,
    };
    return { deps, partition, uploads, recordCharge, reader: createDocumentReadTool(deps) };
  };

  const invoke = async (
    reader: ReturnType<typeof build>['reader'],
    filename: string,
    sessionId?: string,
  ) => {
    const message = await reader.invoke({
      id: 'call-1',
      name: 'read_document',
      args: { filename },
      type: 'tool_call',
      session_id: sessionId,
    });
    return message as unknown as {
      content: string;
      artifact?: { session_id: string; files: { name: string }[] };
    };
  };

  it('sends a whole image and adds its files to the sandbox session', async () => {
    const { reader, partition, uploads } = build();
    const { content, artifact } = await invoke(reader, 'photo.png', 'exec-9');
    expect(partition).toHaveBeenCalledTimes(1);
    expect(content).toContain('# OCR title');
    expect(content).toContain('/mnt/data/document-fedcba65.elements.json');
    expect(artifact?.session_id).toBe('exec-9');
    expect(artifact?.files.map((f) => f.name)).toEqual([
      'document-fedcba65.elements.json',
      'document-fedcba65.md',
    ]);
    expect(JSON.parse(uploads['document-fedcba65.elements.json'])[0].text).toBe('OCR title');
  });

  const threePagePdf = async () => {
    const source = await PDFDocument.create();
    [100, 200, 300].forEach((width) => source.addPage([width, 100]));
    return Buffer.from(await source.save());
  };

  it('sends only the pages that need OCR and keeps the parser text of the rest', async () => {
    const bytes = await threePagePdf();
    const { reader, partition } = build({ readBytes: async () => bytes });
    const { content } = await invoke(reader, 'order.pdf');
    const sent = (partition.mock.calls[0] as unknown as [{ buffer: Buffer }])[0];
    const subset = await PDFDocument.load(sent.buffer);
    expect(subset.getPages().map((page) => page.getWidth())).toEqual([200, 300]);
    expect(content).toContain('typed first page');
    expect(content).toContain('<!-- page 2 -->');
    expect(content).not.toContain('garbage');
  });

  it('reads a PDF recorded as text/plain because its text was extracted at upload', async () => {
    const bytes = await threePagePdf();
    const { reader, partition } = build({
      listFiles: async () => [{ ...pdf, type: 'text/plain' }],
      readBytes: async () => bytes,
    });
    await invoke(reader, 'order.pdf');
    expect(partition).toHaveBeenCalledTimes(1);
  });

  it('charges once, for the pages that came back', async () => {
    const bytes = await threePagePdf();
    const { reader, recordCharge } = build({ readBytes: async () => bytes });
    await invoke(reader, 'order.pdf');
    await invoke(reader, 'order.pdf');
    expect(recordCharge).toHaveBeenCalledTimes(1);
    expect(recordCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: 2,
        file: expect.objectContaining({ file_id: pdf.file_id }),
      }),
    );
  });

  it('does not charge when the service returns nothing', async () => {
    const { reader, recordCharge } = build({
      client: { partition: jest.fn(async () => []) },
    });
    await invoke(reader, 'photo.png');
    expect(recordCharge).not.toHaveBeenCalled();
  });

  it('keeps the answer when the charge cannot be recorded', async () => {
    const { reader } = build({
      recordCharge: async () => {
        throw new Error('database down');
      },
    });
    const { content } = await invoke(reader, 'photo.png');
    expect(content).toContain('# OCR title');
  });

  it('sends nothing, charges nothing and keeps the typed pages when the allowance is short', async () => {
    const bytes = await threePagePdf();
    const { reader, partition, recordCharge } = build({
      readBytes: async () => bytes,
      checkAllowance: async () => false,
    });
    const { content } = await invoke(reader, 'order.pdf');
    expect(partition).not.toHaveBeenCalled();
    expect(recordCharge).not.toHaveBeenCalled();
    expect(content).toContain('not enough allowance');
    expect(content).toContain('typed first page');
    expect(content).not.toContain('garbage');
  });

  it('stops at the page limit and says which pages were not read', async () => {
    const bytes = await threePagePdf();
    const { reader, partition } = build({ maxPages: 1, readBytes: async () => bytes });
    const { content } = await invoke(reader, 'order.pdf');
    const sent = (partition.mock.calls[0] as unknown as [{ buffer: Buffer }])[0];
    expect((await PDFDocument.load(sent.buffer)).getPageCount()).toBe(1);
    expect(content).toContain('Pages 3 were NOT read');
    expect(content).not.toContain('garbage');
  });

  it('does not pay twice for the same file', async () => {
    const { reader, partition } = build();
    await invoke(reader, 'photo.png');
    const { artifact } = await invoke(reader, 'photo.png');
    expect(partition).toHaveBeenCalledTimes(1);
    expect(artifact?.session_id).toBe('storage-1');
  });

  it('labels the lines of a fresh read once and keeps the roles in the cache', async () => {
    const labelStructure = jest.fn(
      async (_file: unknown, _buffer: unknown, read: UnstructuredElement[]) =>
        read.map((element) => ({
          ...element,
          metadata: { ...element.metadata, line_roles: ['title'] },
        })),
    );
    const { reader, uploads } = build({ labelStructure });
    await invoke(reader, 'photo.png');
    await invoke(reader, 'photo.png');
    expect(labelStructure).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(uploads['document-fedcba65.elements.json']);
    expect(sent[0].metadata.line_roles).toEqual(['title']);
  });

  it('keeps the read without roles when labelling fails', async () => {
    const labelStructure = jest.fn(async () => {
      throw new Error('no model');
    });
    const { reader, uploads } = build({ labelStructure });
    const { content } = await invoke(reader, 'photo.png');
    expect(content).toContain('# OCR title');
    const sent = JSON.parse(uploads['document-fedcba65.elements.json']);
    expect(sent[0].metadata.line_roles).toBeUndefined();
  });

  it('lists the files when the name is wrong, and sends nothing', async () => {
    const { reader, partition } = build();
    const { content } = await invoke(reader, 'missing.pdf');
    expect(content).toContain('"order.pdf"');
    expect(partition).not.toHaveBeenCalled();
  });

  it('points to the sandbox recipe when the service fails, so the turn continues', async () => {
    const failing = jest.fn(async () => {
      throw new Error('boom');
    });
    const { reader } = build({ client: { partition: failing } });
    const { content, artifact } = await invoke(reader, 'photo.png');
    expect(content).toContain('sandbox recipe');
    expect(artifact).toBeUndefined();
  });
});
