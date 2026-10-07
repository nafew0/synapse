import { createServer } from 'http';
import type { AddressInfo } from 'net';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import type { FirecrawlConfig } from './client';
import {
  scrapeFirecrawl,
  searchFirecrawl,
  getFirecrawlConfig,
  isFirecrawlConfigured,
} from './client';
import { createFirecrawlTool } from './tool';

interface RecordedRequest {
  path?: string;
  authorization?: string;
  body: Record<string, string | number | boolean | string[] | object>;
}

type Reply = { status: number; body: object };

describe('Firecrawl client', () => {
  let server: Server;
  let config: FirecrawlConfig;
  let requests: RecordedRequest[];
  let reply: Reply;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        requests.push({
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(raw || '{}'),
        });
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    config = {
      apiKey: 'fc-test',
      apiUrl: `http://127.0.0.1:${port}`,
      maxChars: 50,
      timeoutMs: 5000,
      maxSearches: 2,
      maxScrapes: 2,
      pdfMaxPages: 3,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  describe('isFirecrawlConfigured', () => {
    it('is false for a missing or placeholder key and true for a real one', () => {
      expect(isFirecrawlConfigured({})).toBe(false);
      expect(isFirecrawlConfigured({ FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' })).toBe(false);
      expect(isFirecrawlConfigured({ FIRECRAWL_API_KEY: 'fc-1' })).toBe(true);
    });
  });

  describe('getFirecrawlConfig', () => {
    it('throws when the API key is missing or an unresolved placeholder', () => {
      expect(() => getFirecrawlConfig({})).toThrow('Missing FIRECRAWL_API_KEY');
      expect(() => getFirecrawlConfig({ FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' })).toThrow(
        'Missing FIRECRAWL_API_KEY',
      );
    });

    it('defaults the URL and limits, and strips a trailing slash from a custom URL', () => {
      expect(getFirecrawlConfig({ FIRECRAWL_API_KEY: 'k' })).toEqual({
        apiKey: 'k',
        apiUrl: 'https://api.firecrawl.dev',
        maxChars: 20000,
        timeoutMs: 60000,
        maxSearches: 2,
        maxScrapes: 5,
        pdfMaxPages: 5,
      });
      expect(
        getFirecrawlConfig({
          FIRECRAWL_API_KEY: 'k',
          FIRECRAWL_API_URL: 'http://firecrawl:3002/',
          FIRECRAWL_MAX_CHARS: '800',
          FIRECRAWL_TIMEOUT_MS: 'not-a-number',
          FIRECRAWL_MAX_SEARCHES: '1',
          FIRECRAWL_MAX_SCRAPES: '3',
          FIRECRAWL_PDF_MAX_PAGES: '0',
        }),
      ).toEqual({
        apiKey: 'k',
        apiUrl: 'http://firecrawl:3002',
        maxChars: 800,
        timeoutMs: 60000,
        maxSearches: 1,
        maxScrapes: 3,
        pdfMaxPages: 5,
      });
    });
  });

  describe('searchFirecrawl', () => {
    it('sends the v2 search request and formats web and news results', async () => {
      reply = {
        status: 200,
        body: {
          success: true,
          data: {
            web: [{ url: 'https://a.org/p', title: 'Paper A', description: 'About A' }],
            news: [
              { url: 'https://n.com/x', title: 'News X', snippet: 'Today', date: '2026-10-01' },
            ],
          },
        },
      };

      const text = await searchFirecrawl(config, {
        query: 'rice yield 2026',
        time_range: 'month',
        sources: ['web', 'news'],
        include_domains: ['a.org'],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe('/v2/search');
      expect(requests[0].authorization).toBe('Bearer fc-test');
      expect(requests[0].body).toEqual({
        query: 'rice yield 2026',
        limit: 5,
        sources: ['web', 'news'],
        tbs: 'qdr:m',
        includeDomains: ['a.org'],
        timeout: 5000,
      });
      expect(text).toBe(
        '1. Paper A\nURL: https://a.org/p\nAbout A\n\n2. News X\nURL: https://n.com/x\nDate: 2026-10-01\nToday',
      );
    });

    it('reports when nothing was found', async () => {
      reply = { status: 200, body: { success: true, data: { web: [] } } };
      await expect(searchFirecrawl(config, { query: 'nothing' })).resolves.toBe(
        'No results found for "nothing".',
      );
    });

    it('throws with the Firecrawl error on a failed request', async () => {
      reply = { status: 402, body: { success: false, error: 'Payment required' } };
      await expect(searchFirecrawl(config, { query: 'x' })).rejects.toThrow(
        'Firecrawl request failed with status 402: Payment required',
      );
    });
  });

  describe('scrapeFirecrawl', () => {
    it('returns the page markdown with its title and final URL', async () => {
      reply = {
        status: 200,
        body: {
          success: true,
          data: {
            markdown: 'Short body',
            metadata: { title: 'Page', url: 'https://b.gov.bd/final', statusCode: 200 },
          },
        },
      };

      const text = await scrapeFirecrawl(config, { url: 'https://b.gov.bd/start' });

      expect(requests[0].path).toBe('/v2/scrape');
      expect(requests[0].body).toEqual({
        url: 'https://b.gov.bd/start',
        formats: ['markdown'],
        onlyMainContent: true,
        blockAds: true,
        timeout: 5000,
        parsers: [{ type: 'pdf', maxPages: 3 }],
      });
      expect(text).toBe('# Page\nURL: https://b.gov.bd/final\n\nShort body');
    });

    it('truncates content longer than the configured limit', async () => {
      reply = { status: 200, body: { success: true, data: { markdown: 'x'.repeat(120) } } };
      const text = await scrapeFirecrawl(config, { url: 'https://c.com' });
      expect(text).toBe(
        `URL: https://c.com/\n\n${'x'.repeat(50)}\n\n[Truncated: showing the first 50 of 120 characters.]`,
      );
    });

    it('explains an empty page instead of returning nothing', async () => {
      reply = {
        status: 200,
        body: { success: true, data: { markdown: '', metadata: { statusCode: 404 } } },
      };
      await expect(scrapeFirecrawl(config, { url: 'https://d.com/missing' })).resolves.toBe(
        'No readable content at https://d.com/missing (status 404).',
      );
    });

    it('rejects non-http URLs without calling Firecrawl', async () => {
      await expect(scrapeFirecrawl(config, { url: 'file:///etc/passwd' })).rejects.toThrow(
        'Only http and https URLs can be read',
      );
      await expect(scrapeFirecrawl(config, { url: 'not a url' })).rejects.toThrow('Invalid URL');
      expect(requests).toHaveLength(0);
    });
  });

  describe('createFirecrawlTool', () => {
    it('runs the search tool end to end through its LangChain wrapper', async () => {
      reply = {
        status: 200,
        body: { success: true, data: { web: [{ url: 'https://e.org', title: 'E' }] } },
      };
      const searchTool = createFirecrawlTool('firecrawl_search', { config });
      expect(searchTool.name).toBe('firecrawl_search');
      await expect(searchTool.invoke({ query: 'e' })).resolves.toBe('1. E\nURL: https://e.org');
    });

    it('shares one budget across tools created for the same request', async () => {
      reply = { status: 200, body: { success: true, data: { markdown: 'Body' } } };
      const budgetScope = {};
      const first = createFirecrawlTool('firecrawl_scrape', { config, budgetScope });
      const second = createFirecrawlTool('firecrawl_scrape', { config, budgetScope });

      await first.invoke({ url: 'https://f.org/1' });
      await second.invoke({ url: 'https://f.org/2' });
      const refused = await second.invoke({ url: 'https://f.org/3' });

      expect(requests).toHaveLength(2);
      expect(refused).toContain('Budget reached: firecrawl_scrape has been used 2 of 2 times');
    });

    it('counts searches and scrapes separately, and a new request gets a fresh budget', async () => {
      reply = { status: 200, body: { success: true, data: { web: [] } } };
      const scope = {};
      const search = createFirecrawlTool('firecrawl_search', { config, budgetScope: scope });
      await search.invoke({ query: 'a' });
      await search.invoke({ query: 'b' });
      await expect(search.invoke({ query: 'c' })).resolves.toContain('Budget reached');

      const nextTurn = createFirecrawlTool('firecrawl_search', { config, budgetScope: {} });
      await expect(nextTurn.invoke({ query: 'd' })).resolves.toBe('No results found for "d".');
      expect(requests).toHaveLength(3);
    });

    it('rejects names that are not Firecrawl tools', () => {
      expect(() => createFirecrawlTool('web_search', { config })).toThrow('Unknown Firecrawl tool');
    });
  });
});
