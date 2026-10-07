import { fetch } from 'undici';
import { logger } from '@librechat/data-schemas';
import type { RequestInit } from 'undici';
import type { firecrawlSources, firecrawlTimeRanges } from './definitions';
import type { FirecrawlLimits } from './budget';
import { getEnvProxyDispatcher } from '~/utils/proxy';
import { cleanMarkdown } from './markdown';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const DEFAULT_MAX_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_SEARCHES = 2;
const DEFAULT_MAX_SCRAPES = 5;
const DEFAULT_PDF_MAX_PAGES = 5;
const SNIPPET_MAX_CHARS = 300;

const TIME_RANGE_TBS: Record<FirecrawlTimeRange, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

export type FirecrawlTimeRange = (typeof firecrawlTimeRanges)[number];
export type FirecrawlSource = (typeof firecrawlSources)[number];

export interface FirecrawlConfig extends FirecrawlLimits {
  apiKey: string;
  apiUrl: string;
  maxChars: number;
  timeoutMs: number;
  pdfMaxPages: number;
}

export interface FirecrawlSearchInput {
  query: string;
  limit?: number;
  sources?: FirecrawlSource[];
  time_range?: FirecrawlTimeRange;
  include_domains?: string[];
  country?: string;
}

export interface FirecrawlScrapeInput {
  url: string;
}

interface FirecrawlSearchResult {
  url?: string;
  title?: string;
  description?: string;
  snippet?: string;
  date?: string;
}

interface FirecrawlResponse {
  success?: boolean;
  error?: string;
  creditsUsed?: number;
}

interface FirecrawlSearchResponse extends FirecrawlResponse {
  data?: {
    web?: FirecrawlSearchResult[];
    news?: FirecrawlSearchResult[];
  };
}

interface FirecrawlScrapeResponse extends FirecrawlResponse {
  data?: {
    markdown?: string;
    metadata?: {
      title?: string | string[];
      url?: string;
      sourceURL?: string;
      statusCode?: number;
      error?: string | null;
      creditsUsed?: number;
    };
  };
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isUnsetEnv = (value: string | undefined): value is undefined =>
  !value || value.startsWith('${');

/** Whether a Firecrawl API key is configured, so the tools can be offered to the model. */
export const isFirecrawlConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !isUnsetEnv(env.FIRECRAWL_API_KEY);

/** Reads Firecrawl settings from the environment; throws when no API key is configured. */
export function getFirecrawlConfig(env: NodeJS.ProcessEnv = process.env): FirecrawlConfig {
  const apiKey = env.FIRECRAWL_API_KEY;
  if (isUnsetEnv(apiKey)) {
    throw new Error('Missing FIRECRAWL_API_KEY environment variable.');
  }
  const apiUrl = isUnsetEnv(env.FIRECRAWL_API_URL) ? DEFAULT_API_URL : env.FIRECRAWL_API_URL;
  return {
    apiKey,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    maxChars: parsePositiveInt(env.FIRECRAWL_MAX_CHARS, DEFAULT_MAX_CHARS),
    timeoutMs: parsePositiveInt(env.FIRECRAWL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxSearches: parsePositiveInt(env.FIRECRAWL_MAX_SEARCHES, DEFAULT_MAX_SEARCHES),
    maxScrapes: parsePositiveInt(env.FIRECRAWL_MAX_SCRAPES, DEFAULT_MAX_SCRAPES),
    pdfMaxPages: parsePositiveInt(env.FIRECRAWL_PDF_MAX_PAGES, DEFAULT_PDF_MAX_PAGES),
  };
}

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;

async function post<T extends FirecrawlResponse>(
  config: FirecrawlConfig,
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(config.timeoutMs + 5000);
  const options: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
  const dispatcher = getEnvProxyDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }

  const response = await fetch(`${config.apiUrl}${path}`, options);
  const json = (await response.json().catch(() => ({}))) as T;
  if (!response.ok || json.success === false) {
    throw new Error(
      `Firecrawl request failed with status ${response.status}: ${json.error ?? response.statusText}`,
    );
  }
  return json;
}

const logCredits = (call: 'search' | 'scrape', target: string, credits?: number): void => {
  logger.info(`[Firecrawl] ${call} credits=${credits ?? 'unknown'} ${target.slice(0, 200)}`);
};

const formatSearchResult = (result: FirecrawlSearchResult, index: number): string => {
  const lines = [`${index + 1}. ${result.title || result.url || 'Untitled'}`, `URL: ${result.url}`];
  if (result.date) {
    lines.push(`Date: ${result.date}`);
  }
  const snippet = result.description || result.snippet;
  if (snippet) {
    lines.push(truncate(snippet, SNIPPET_MAX_CHARS));
  }
  return lines.join('\n');
};

/** Runs a Firecrawl search and returns the results as compact text for the model. */
export async function searchFirecrawl(
  config: FirecrawlConfig,
  input: FirecrawlSearchInput,
  signal?: AbortSignal,
): Promise<string> {
  const json = await post<FirecrawlSearchResponse>(
    config,
    '/v2/search',
    {
      query: input.query,
      limit: input.limit ?? 5,
      sources: input.sources?.length ? input.sources : ['web'],
      tbs: input.time_range ? TIME_RANGE_TBS[input.time_range] : undefined,
      includeDomains: input.include_domains?.length ? input.include_domains : undefined,
      country: input.country,
      timeout: config.timeoutMs,
    },
    signal,
  );

  logCredits('search', input.query, json.creditsUsed);
  const results = [...(json.data?.web ?? []), ...(json.data?.news ?? [])].filter((r) => r.url);
  if (results.length === 0) {
    return `No results found for "${input.query}".`;
  }
  return results.map(formatSearchResult).join('\n\n');
}

const assertHttpUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be read: ${value}`);
  }
  return parsed.toString();
};

/** Scrapes one URL with Firecrawl and returns its main content as cleaned markdown, truncated. */
export async function scrapeFirecrawl(
  config: FirecrawlConfig,
  input: FirecrawlScrapeInput,
  signal?: AbortSignal,
): Promise<string> {
  const url = assertHttpUrl(input.url);
  const json = await post<FirecrawlScrapeResponse>(
    config,
    '/v2/scrape',
    {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      blockAds: true,
      timeout: config.timeoutMs,
      parsers: [{ type: 'pdf', maxPages: config.pdfMaxPages }],
    },
    signal,
  );

  const metadata = json.data?.metadata;
  logCredits('scrape', url, json.creditsUsed ?? metadata?.creditsUsed);
  const markdown = cleanMarkdown(json.data?.markdown ?? '').trim();
  const finalUrl = metadata?.url || metadata?.sourceURL || url;
  if (!markdown) {
    const reason = metadata?.error || `status ${metadata?.statusCode ?? 'unknown'}`;
    return `No readable content at ${finalUrl} (${reason}).`;
  }

  const title = Array.isArray(metadata?.title) ? metadata?.title[0] : metadata?.title;
  const header = [title ? `# ${title}` : null, `URL: ${finalUrl}`].filter(Boolean).join('\n');
  if (markdown.length <= config.maxChars) {
    return `${header}\n\n${markdown}`;
  }
  return `${header}\n\n${markdown.slice(0, config.maxChars).trimEnd()}\n\n[Truncated: showing the first ${config.maxChars} of ${markdown.length} characters.]`;
}
