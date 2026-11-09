import http from 'http';
import sharp from 'sharp';
import type { AddressInfo } from 'net';
import type { StructureOptions } from './structure';
import type { UnstructuredElement } from './types';
import { imageRenderer, labelLines, pageLines } from './structure';

const box = (x0: number, y0: number, x1: number, y1: number) => ({
  coordinates: {
    points: [
      [x0, y0],
      [x0, y1],
      [x1, y1],
      [x1, y0],
    ],
    system: 'PixelSpace',
    layout_width: 1000,
    layout_height: 2000,
  },
});

const order: UnstructuredElement[] = [
  { type: 'Title', text: 'অফিস আদেশ', metadata: { page_number: 1, ...box(400, 100, 600, 150) } },
  {
    type: 'NarrativeText',
    text: 'কর্তৃপক্ষের অনুমোদনক্রমে,\nতাহমিনা রহমান\n12',
    metadata: { page_number: 1, ...box(600, 1500, 900, 1800) },
  },
  { type: 'Table', text: 'ক্রম\nনাম', metadata: { page_number: 2, ...box(50, 50, 950, 1900) } },
  { type: 'NarrativeText', text: 'typed text', metadata: { page_number: 3, source: 'parser' } },
];

interface FakeAnswer {
  status?: number;
  content?: string;
}

/** A local stand-in for OpenRouter's chat completions endpoint, so real HTTP is exercised. */
function startFake(answer: (body: { messages: { content: unknown[] }[] }) => FakeAnswer) {
  const seen: { auth?: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ auth: req.headers.authorization, body });
      const { status = 200, content = '{}' } = answer(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0005 } }));
    });
  });
  return new Promise<{ options: StructureOptions; seen: typeof seen; close: () => void }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          seen,
          close: () => server.close(),
          options: {
            apiUrl: `http://127.0.0.1:${port}/api/v1`,
            apiKey: 'test-key',
            model: 'google/gemini-2.5-flash-lite',
            timeoutMs: 5000,
          },
        });
      });
    },
  );
}

const blankPage = () => Promise.resolve(Buffer.from('page'));

describe('pageLines', () => {
  it('splits each element into its lines with the page fraction box, a table as one line', () => {
    expect(pageLines(order, 1)).toEqual([
      { id: 'e0.0', box: [0.4, 0.05, 0.6, 0.075], text: 'অফিস আদেশ' },
      { id: 'e1.0', box: [0.6, 0.75, 0.9, 0.9], text: 'কর্তৃপক্ষের অনুমোদনক্রমে,' },
      { id: 'e1.1', box: [0.6, 0.75, 0.9, 0.9], text: 'তাহমিনা রহমান' },
      { id: 'e1.2', box: [0.6, 0.75, 0.9, 0.9], text: '12' },
    ]);
    expect(pageLines(order, 2)).toEqual([
      { id: 'e2.0', box: [0.05, 0.025, 0.95, 0.95], text: 'ক্রম নাম' },
    ]);
  });

  it('leaves out pages Synapse read from the PDF itself', () => {
    expect(pageLines(order, 3)).toEqual([]);
  });
});

describe('labelLines', () => {
  it('puts each line role on its element, one per line, and asks for no text', async () => {
    const fake = await startFake((body) => {
      const listing = JSON.stringify(body.messages[0].content);
      const page = listing.includes('e2.0') ? 2 : 1;
      const blocks =
        page === 1
          ? [
              { id: 'e0.0', role: 'title' },
              { id: 'e1.0', role: 'signature' },
              { id: 'e1.1', role: 'signature' },
              { id: 'e1.2', role: 'page_number' },
            ]
          : [{ id: 'e2.0', role: 'table' }];
      return { content: JSON.stringify({ blocks, side_by_side: [], reading_order: [] }) };
    });
    try {
      const result = await labelLines({
        elements: order,
        render: blankPage,
        options: fake.options,
      });
      expect(result.elements.map((element) => element.metadata?.line_roles)).toEqual([
        ['title'],
        ['signature', 'signature', 'page_number'],
        ['table'],
        undefined,
      ]);
      expect(result.failedPages).toEqual([]);
      expect(result.cost).toBeCloseTo(0.001);
      expect(fake.seen).toHaveLength(2);
      const request = fake.seen[0];
      expect(request.auth).toBe('Bearer test-key');
      expect(request.body.model).toBe('google/gemini-2.5-flash-lite');
      const schema = JSON.stringify(request.body.response_format);
      expect(schema).toContain('"strict":true');
      expect(schema).not.toContain('"text"');
      expect(JSON.stringify(request.body.messages)).toContain('data:image/jpeg;base64,');
      expect(order[1].metadata?.line_roles).toBeUndefined();
    } finally {
      fake.close();
    }
  });

  it('drops roles outside the list and ids it never sent', async () => {
    const fake = await startFake(() => ({
      content: JSON.stringify({
        blocks: [
          { id: 'e0.0', role: 'banner' },
          { id: 'e1.1', role: 'signature' },
          { id: 'e9.9', role: 'title' },
        ],
        side_by_side: [],
        reading_order: [],
      }),
    }));
    try {
      const result = await labelLines({
        elements: order.slice(0, 2),
        render: blankPage,
        options: fake.options,
      });
      expect(result.elements.map((element) => element.metadata?.line_roles)).toEqual([
        undefined,
        [null, 'signature', null],
      ]);
    } finally {
      fake.close();
    }
  });

  it('leaves the read as it was when the call fails or answers nonsense', async () => {
    for (const answer of [{ status: 500 }, { content: 'not json' }]) {
      const fake = await startFake(() => answer);
      try {
        const result = await labelLines({
          elements: order,
          render: blankPage,
          options: fake.options,
        });
        expect(result.elements).toEqual(order);
        expect(result.failedPages).toEqual([1, 2]);
      } finally {
        fake.close();
      }
    }
  });

  it('leaves a page as it was when it cannot be drawn', async () => {
    const fake = await startFake(() => ({ content: '{}' }));
    try {
      const result = await labelLines({
        elements: order,
        render: () => Promise.reject(new Error('no canvas')),
        options: fake.options,
      });
      expect(result.elements).toEqual(order);
      expect(fake.seen).toHaveLength(0);
    } finally {
      fake.close();
    }
  });
});

describe('imageRenderer', () => {
  it('sends a photo as a JPEG no longer than 1600 px on its long side', async () => {
    const photo = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const page = await imageRenderer(photo)(1);
    const { width, height, format } = await sharp(page).metadata();
    expect(format).toBe('jpeg');
    expect(Math.max(width ?? 0, height ?? 0)).toBe(1600);
  });
});
