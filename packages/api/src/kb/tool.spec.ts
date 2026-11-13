import { buildInstitutionKbInstructions, formatKbResults } from './tool';
import { forgetInstitutionKb, getInstitutionKbCatalog, getKbRagApiUrl } from './availability';

describe('formatKbResults', () => {
  it('numbers each source with its document, section and pages', () => {
    const text = formatKbResults([
      {
        title: 'BdREN contacts',
        doc_type: 'directory',
        section_path: '1. Team directory',
        page_start: 1,
        page_end: 1,
        text: '| Team | Email |\n| NOC | noc@bdren.net.bd |',
      },
      {
        title: 'HR policy',
        doc_type: 'policy',
        section_path: '',
        page_start: 3,
        page_end: 4,
        text: 'Annual leave is twenty days.',
      },
      {
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
      tenantId === 'uni-a' ? [{ title: 'HR policy', docType: 'policy' }] : [],
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
      { title: 'Draft Policy for\nWork-From-Home', docType: 'policy' },
      { title: 'BdREN contacts', docType: 'directory' },
    ]);
    expect(text).toContain(
      '- Draft Policy for Work-From-Home (policy)\n- BdREN contacts (directory)',
    );
    expect(text).toMatch(/call `institution_kb` before using web search/);
    expect(text).toMatch(/"home office"/);
  });

  it('caps a long list', () => {
    const catalog = Array.from({ length: 45 }, (_, i) => ({ title: `Doc ${i}`, docType: 'other' }));
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
