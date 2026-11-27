import http from 'http';
import type { AddressInfo } from 'net';
import { buildInstitutionKbInstructions, createInstitutionKbTool, formatKbResults } from './tool';
import { forgetInstitutionKb, getInstitutionKbCatalog, getKbRagApiUrl } from './availability';

describe('formatKbResults', () => {
  it('numbers each source with its document, section and pages', () => {
    const text = formatKbResults([
      {
        doc_id: 'd1',
        title: 'BdREN contacts',
        doc_type: 'directory',
        section_path: '1. Team directory',
        page_start: 1,
        page_end: 1,
        text: '| Team | Email |\n| NOC | noc@bdren.net.bd |',
      },
      {
        doc_id: 'd2',
        title: 'HR policy',
        doc_type: 'policy',
        section_path: '',
        page_start: 3,
        page_end: 4,
        text: 'Annual leave is twenty days.',
      },
      {
        doc_id: 'd3',
        title: 'Notes',
        doc_type: 'other',
        section_path: '',
        page_start: null,
        page_end: null,
        text: 'Hours: 24/7',
      },
    ]);
    expect(text).toBe(
      '[1] BdREN contacts › 1. Team directory, page 1\n| Team | Email |\n| NOC | noc@bdren.net.bd |\n\n' +
        '[2] HR policy, pages 3–4\nAnnual leave is twenty days.\n\n' +
        '[3] Notes\nHours: 24/7',
    );
  });

  it('says plainly when nothing was found', () => {
    expect(formatKbResults([])).toMatch(/Nothing relevant/);
  });
});

describe('getInstitutionKbCatalog', () => {
  it('loads once a minute per tenant and never without a tenant', async () => {
    const load = jest.fn(async (tenantId: string) =>
      tenantId === 'uni-a' ? [{ id: 'd1', title: 'HR policy', docType: 'policy' }] : [],
    );
    expect(await getInstitutionKbCatalog(undefined, load)).toEqual([]);
    expect(await getInstitutionKbCatalog('uni-a', load, 1_000)).toHaveLength(1);
    expect(await getInstitutionKbCatalog('uni-a', load, 30_000)).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
    await getInstitutionKbCatalog('uni-a', load, 62_000);
    expect(load).toHaveBeenCalledTimes(2);
    forgetInstitutionKb('uni-a');
    await getInstitutionKbCatalog('uni-a', load, 62_001);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('buildInstitutionKbInstructions', () => {
  it('lists the documents and tells the model to search them before other sources', () => {
    const text = buildInstitutionKbInstructions([
      { id: 'd1', title: 'Draft Policy for\nWork-From-Home', docType: 'policy' },
      { id: 'd2', title: 'BdREN contacts', docType: 'directory' },
    ]);
    expect(text).toContain(
      '- Draft Policy for Work-From-Home (policy)\n- BdREN contacts (directory)',
    );
    expect(text).toMatch(/call `institution_kb` before using web search/);
    expect(text).toMatch(/"home office"/);
    expect(text).toMatch(/give every relevant part the results contain/);
    expect(text).toMatch(/even when the user writes casually/);
    expect(text).toMatch(/search for their names and emails/);
    expect(text).not.toContain('doc_types');
    expect(text).toMatch(/refers to another section, search for that section/);
  });

  it('caps a long list', () => {
    const catalog = Array.from({ length: 45 }, (_, i) => ({
      id: `d${i}`,
      title: `Doc ${i}`,
      docType: 'other',
    }));
    const text = buildInstitutionKbInstructions(catalog);
    expect(text).toContain('- Doc 39 (other)');
    expect(text).not.toContain('- Doc 40 (other)');
    expect(text).toContain('…and 5 more documents');
  });
});

describe('getKbRagApiUrl', () => {
  const saved = { kb: process.env.KB_RAG_API_URL, rag: process.env.RAG_API_URL };
  afterEach(() => {
    process.env.KB_RAG_API_URL = saved.kb;
    process.env.RAG_API_URL = saved.rag;
  });

  it('prefers the knowledge base RAG API and falls back to the file search one', () => {
    process.env.RAG_API_URL = 'https://rag.example';
    delete process.env.KB_RAG_API_URL;
    expect(getKbRagApiUrl()).toBe('https://rag.example');
    process.env.KB_RAG_API_URL = 'http://127.0.0.1:8010';
    expect(getKbRagApiUrl()).toBe('http://127.0.0.1:8010');
  });
});

interface Hit {
  doc_id: string;
  text: string;
  page_start?: number;
}

interface QueryBody {
  query: string;
  k: number;
  doc_types?: string[];
}

const hit = ({ doc_id, text, page_start = 1 }: Hit) => ({
  doc_id,
  title: doc_id === 'live' ? 'HR policy' : 'Deleted',
  doc_type: 'policy',
  section_path: '',
  page_start,
  page_end: page_start,
  text,
});

/** A real local RAG API stand-in that records each request body and answers with `hits`. */
async function withRagApi(
  hits: Hit[],
  run: (url: string, bodies: QueryBody[]) => Promise<void>,
): Promise<void> {
  process.env.RAG_JWT_SECRET = 'test-secret';
  const bodies: QueryBody[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (part: Buffer) => (raw += part.toString()));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as QueryBody);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: hits.map(hit) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, bodies);
  } finally {
    server.close();
  }
}

describe('createInstitutionKbTool', () => {
  it('never shows results from a document that no longer has a record', async () => {
    await withRagApi(
      [
        { doc_id: 'gone', text: 'stale' },
        { doc_id: 'live', text: 'Twenty days', page_start: 2 },
      ],
      async (ragApiUrl) => {
        const kbTool = createInstitutionKbTool({
          ragApiUrl,
          tenantId: 'uni-a',
          knownDocumentIds: async () => new Set(['live']),
        });
        const output = await kbTool.invoke({ query: 'leave' });
        expect(output).toBe('[1] HR policy, page 2\nTwenty days');
      },
    );
  });

  it('asks for twelve results and shows repeated text only once', async () => {
    await withRagApi(
      [
        { doc_id: 'live', text: 'SPECIAL CLAUSE\nThe CEO may  allow it.', page_start: 3 },
        { doc_id: 'live', text: 'Apply to HR.', page_start: 2 },
        { doc_id: 'live', text: ' special clause the ceo\nmay allow it. ', page_start: 4 },
      ],
      async (ragApiUrl, bodies) => {
        const kbTool = createInstitutionKbTool({ ragApiUrl, tenantId: 'uni-a' });
        const output = await kbTool.invoke({ query: 'home office' });
        expect(bodies).toEqual([{ query: 'home office', k: 12 }]);
        expect(output).toBe(
          '[1] HR policy, page 3\nSPECIAL CLAUSE\nThe CEO may  allow it.\n\n' +
            '[2] HR policy, page 2\nApply to HR.',
        );
      },
    );
  });
});
