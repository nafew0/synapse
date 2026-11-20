import http from 'http';
import type { AddressInfo } from 'net';
import type { DoclingDocument } from './types';
import { createDoclingClient } from './docling';

const document: DoclingDocument = {
  schema_name: 'DoclingDocument',
  version: '1.0.0',
  name: 'file',
  body: { self_ref: '#/body', label: 'unspecified', children: [] },
  groups: [],
  texts: [],
  tables: [],
  pictures: [],
};

/** A docling-serve stand-in that records submitted forms and how many tasks run at once. */
function startDocling() {
  const forms: string[] = [];
  let running = 0;
  let peak = 0;
  let next = 0;
  const polls = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const json = (body: object) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/v1/convert/file/async') {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        forms.push(Buffer.concat(parts).toString('latin1'));
        running++;
        peak = Math.max(peak, running);
        json({ task_id: `t${next++}`, task_status: 'pending' });
      });
      return;
    }
    if (url.startsWith('/v1/status/poll/')) {
      /* Like docling-serve 1.38.2: answers at once, whatever `wait` says. */
      const id = url.split('/')[4].split('?')[0];
      const count = (polls.get(id) ?? 0) + 1;
      polls.set(id, count);
      json({ task_id: id, task_status: count < 3 ? 'started' : 'success' });
      return;
    }
    if (url.startsWith('/v1/result/')) {
      running--;
      json({ document: { json_content: document }, status: 'success' });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{
    url: string;
    forms: string[];
    peak: () => number;
    polls: Map<string, number>;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        forms,
        peak: () => peak,
        polls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const field = (form: string, name: string): string[] =>
  [...form.matchAll(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`, 'g'))].map((m) => m[1]);

describe('createDoclingClient', () => {
  let docling: Awaited<ReturnType<typeof startDocling>>;

  beforeEach(async () => {
    docling = await startDocling();
  });

  afterEach(async () => {
    await docling.close();
  });

  it('asks for no picture images and sends the page range', async () => {
    const client = createDoclingClient({ baseUrl: docling.url, apiKey: 'key', minPollGapMs: 10 });
    await client.convert({
      buffer: Buffer.from('%PDF'),
      filename: 'long.pdf',
      mimeType: 'application/pdf',
      pageRange: [51, 100],
    });
    const [form] = docling.forms;
    expect(field(form, 'do_ocr')).toEqual(['false']);
    expect(field(form, 'include_images')).toEqual(['false']);
    expect(field(form, 'image_export_mode')).toEqual(['placeholder']);
    expect(field(form, 'page_range')).toEqual(['51', '100']);
  });

  it('sends no page range for a whole file', async () => {
    const client = createDoclingClient({ baseUrl: docling.url, apiKey: 'key', minPollGapMs: 10 });
    await client.convert({ buffer: Buffer.from('x'), filename: 'a.docx', mimeType: 'text/plain' });
    expect(field(docling.forms[0], 'page_range')).toEqual([]);
  });

  it('runs no more conversions at once than its limit', async () => {
    const client = createDoclingClient({
      baseUrl: docling.url,
      apiKey: 'key',
      maxConcurrent: 2,
      minPollGapMs: 10,
    });
    const file = { buffer: Buffer.from('%PDF'), filename: 'a.pdf', mimeType: 'application/pdf' };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.convert(file)));
    expect(results).toHaveLength(5);
    expect(docling.forms).toHaveLength(5);
    expect(docling.peak()).toBe(2);
  });

  it('waits between polls when Docling answers at once', async () => {
    const client = createDoclingClient({ baseUrl: docling.url, apiKey: 'key', minPollGapMs: 100 });
    const started = Date.now();
    await client.convert({
      buffer: Buffer.from('x'),
      filename: 'a.pdf',
      mimeType: 'application/pdf',
    });
    expect(docling.polls.get('t0')).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});
