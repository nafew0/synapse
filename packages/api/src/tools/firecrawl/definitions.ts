import type { ExtendedJsonSchema } from '../registry/schema';

export const FIRECRAWL_SEARCH_TOOL_NAME = 'search_web';
export const FIRECRAWL_SCRAPE_TOOL_NAME = 'read_web_page';

export const firecrawlToolNames: ReadonlySet<string> = new Set([
  FIRECRAWL_SEARCH_TOOL_NAME,
  FIRECRAWL_SCRAPE_TOOL_NAME,
]);

export const isFirecrawlTool = (toolName: string): boolean => firecrawlToolNames.has(toolName);

export const firecrawlTimeRanges = ['day', 'week', 'month', 'year'] as const;
export const firecrawlSources = ['web', 'news'] as const;

const firecrawlSearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'The search query. Include the current year when the user asks for recent work.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Number of results to return. Defaults to 5.',
    },
    sources: {
      type: 'array',
      items: { type: 'string', enum: [...firecrawlSources] },
      description: 'Result types to search. Defaults to ["web"]; add "news" for current events.',
    },
    time_range: {
      type: 'string',
      enum: [...firecrawlTimeRanges],
      description: 'Only return results published within this period.',
    },
    include_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Restrict results to these hostnames, e.g. ["arxiv.org"]. No protocol or path.',
    },
    country: {
      type: 'string',
      description:
        'ISO country code of the place the question is about, e.g. "BD" for anything about Bangladesh. Omit for global topics.',
    },
  },
  required: ['query'],
};

const firecrawlScrapeSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      description: 'The full http(s) URL of the page or PDF to read, exactly as given.',
    },
  },
  required: ['url'],
};

interface FirecrawlToolDefinition {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
}

export const firecrawlToolkit: {
  search_web: FirecrawlToolDefinition;
  read_web_page: FirecrawlToolDefinition;
} = {
  search_web: {
    name: FIRECRAWL_SEARCH_TOOL_NAME,
    description:
      'Searches the web and returns the title, URL and a short snippet of each result. Use it for questions that need current or published information, such as the latest research on a topic. Results contain snippets only: read the pages you rely on with read_web_page before using their content.',
    schema: firecrawlSearchSchema,
  },
  read_web_page: {
    name: FIRECRAWL_SCRAPE_TOOL_NAME,
    description:
      'Reads one web page or PDF and returns its main content as markdown. Use it for every URL the user gives and for the search results you rely on. Long pages are truncated.',
    schema: firecrawlScrapeSchema,
  },
};
