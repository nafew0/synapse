import type { TErrorSummary } from '~/errors/public';

/** One-glance answer to "what broke?" placed at the top of an issue report email. */
export type TDiagnosis = {
  /** What the user was doing, e.g. "File upload (/api/files)". */
  failed?: string;
  /** Short service label, e.g. "Code API"; also used in the subject. */
  serviceLabel?: string;
  /** Full service name, e.g. "Code interpreter (Code API)". */
  service?: string;
  /** The failed outgoing call, e.g. `404 · POST https://code.example/upload`. */
  upstreamCall?: string;
  /** What the service replied, e.g. `{"error":"Not found"}`. */
  upstreamReply?: string;
  /** Where in Synapse code it failed, innermost first. */
  location: string[];
  /** Plain-language likely cause and what to check. */
  cause?: string;
};

type TService = { label: string; name: string };

const SERVICE_ENV: ReadonlyArray<[string, TService]> = [
  ['LIBRECHAT_CODE_BASEURL', { label: 'Code API', name: 'Code interpreter (Code API)' }],
  ['LIBRECHAT_CODE_BASEURL_STATEFUL', { label: 'Code API', name: 'Code interpreter (Code API)' }],
  ['RAG_API_URL', { label: 'RAG API', name: 'RAG API (document search)' }],
  ['FIRECRAWL_API_URL', { label: 'Firecrawl', name: 'Firecrawl (web search)' }],
];

const SERVICE_HOSTS: ReadonlyArray<[RegExp, TService]> = [
  [/openrouter\.ai/i, { label: 'OpenRouter', name: 'OpenRouter (AI model provider)' }],
  [/api\.openai\.com/i, { label: 'OpenAI', name: 'OpenAI (AI model provider)' }],
  [/api\.anthropic\.com/i, { label: 'Anthropic', name: 'Anthropic (AI model provider)' }],
  [/firecrawl\.dev/i, { label: 'Firecrawl', name: 'Firecrawl (web search)' }],
];

const SERVICE_MESSAGES: ReadonlyArray<[RegExp, TService]> = [
  [
    /code environment|code ?api|sandbox/i,
    { label: 'Code API', name: 'Code interpreter (Code API)' },
  ],
  [/\[MCP\]/i, { label: 'MCP', name: 'MCP tool server' }],
  [/rag|vector ?db|embedding/i, { label: 'RAG API', name: 'RAG API (document search)' }],
  [/firecrawl/i, { label: 'Firecrawl', name: 'Firecrawl (web search)' }],
];

const ROUTES: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/files\/images/, 'Image upload'],
  [/^\/api\/files\/?$/, 'File upload'],
  [/^\/api\/files/, 'File operation'],
  [/^\/api\/agents\/chat/, 'Chat reply'],
  [/^\/api\/agents/, 'Agent request'],
  [/^\/api\/(speech|files\/speech)/, 'Speech'],
  [/^\/api\/mcp/, 'MCP server'],
  [/^\/api\/memories/, 'Memories'],
];

const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed/i;
const TIMEOUT = /timed? ?out|ETIMEDOUT|ECONNABORTED|UND_ERR_.*TIMEOUT/i;
const CONTEXT = /context[_ ]length|prompt is too long|maximum context|too many tokens/i;
const BRACKET_PREFIX = /^(\[[^\]]+\]\s*)+[^:]*:\s*/;

function findService(summaries: TErrorSummary[]): TService | undefined {
  for (const { upstream, message } of summaries) {
    const url = upstream?.url;
    if (url) {
      for (const [envKey, service] of SERVICE_ENV) {
        const base = process.env[envKey]?.replace(/\/+$/, '');
        if (base && url.startsWith(base)) {
          return service;
        }
      }
      const byHost = SERVICE_HOSTS.find(([pattern]) => pattern.test(url));
      if (byHost) {
        return byHost[1];
      }
    }
    const byMessage = SERVICE_MESSAGES.find(([pattern]) => pattern.test(message));
    if (byMessage) {
      return byMessage[1];
    }
  }
  return undefined;
}

function describeRoute(route?: string): string | undefined {
  if (!route) {
    return undefined;
  }
  const match = ROUTES.find(([pattern]) => pattern.test(route));
  return match ? `${match[1]} (${route})` : route;
}

function likelyCause(status: number | undefined, text: string): string | undefined {
  if (UNREACHABLE.test(text)) {
    return 'Synapse could not reach the service: it is down, or its URL/DNS is wrong.';
  }
  if (TIMEOUT.test(text) || status === 408 || status === 504) {
    return 'The service did not answer in time: it is overloaded or stuck.';
  }
  if (CONTEXT.test(text)) {
    return 'The conversation exceeded the model context window.';
  }
  if (status === 404) {
    return 'The service answered "not found": the base URL or endpoint path is wrong, the service version changed, or the resource no longer exists.';
  }
  if (status === 401 || status === 403) {
    return 'The service rejected our credentials: check the API key or token configured for it.';
  }
  if (status === 402) {
    return 'The provider account is out of credits or quota.';
  }
  if (status === 429) {
    return 'The service rate-limited us.';
  }
  if (status !== undefined && status >= 500) {
    return 'The service itself failed: check its own logs for this time.';
  }
  if (status !== undefined && status >= 400) {
    return 'The service rejected the request as invalid.';
  }
  return undefined;
}

function coreMessage(message: string): string {
  return message.replace(BRACKET_PREFIX, '').trim();
}

/**
 * Collapses the same failure logged at several layers (e.g. the axios error and
 * the route's "[/files] Error processing file: …" wrapper) into one entry that
 * keeps the most complete message, the upstream call and our own stack frames.
 */
export function mergeSummaries(summaries: TErrorSummary[]): TErrorSummary[] {
  return summaries.reduce<TErrorSummary[]>((merged, summary) => {
    const core = coreMessage(summary.message);
    const index = merged.findIndex((existing) => {
      const existingCore = coreMessage(existing.message);
      return existingCore.includes(core) || core.includes(existingCore);
    });
    if (index === -1) {
      return [...merged, summary];
    }
    const existing = merged[index];
    const frames = [...(existing.frames ?? []), ...(summary.frames ?? [])];
    const combined: TErrorSummary = {
      ...existing,
      message:
        summary.message.length > existing.message.length ? summary.message : existing.message,
      status: existing.status ?? summary.status,
      upstream: existing.upstream ?? summary.upstream,
      frames: frames.length > 0 ? [...new Set(frames)] : undefined,
      stack: existing.frames ? existing.stack : (summary.stack ?? existing.stack),
      provider: existing.provider ?? summary.provider,
      model: existing.model ?? summary.model,
    };
    return merged.map((entry, i) => (i === index ? combined : entry));
  }, []);
}

/** Builds the diagnosis from the (merged) summaries of the reported request. */
export function diagnose(summaries: TErrorSummary[]): TDiagnosis | undefined {
  if (summaries.length === 0) {
    return undefined;
  }
  const root = summaries.find((summary) => summary.upstream) ?? summaries[0];
  const upstream = root.upstream;
  const status = upstream?.status ?? root.status;
  const service = findService(summaries);
  const location = summaries.flatMap((summary) => summary.frames ?? []);
  const upstreamCall = upstream
    ? [status, upstream.method, upstream.url]
        .filter((part) => part != null && part !== '')
        .join(' · ')
    : undefined;

  return {
    failed: describeRoute(root.route),
    serviceLabel: service?.label,
    service: service?.name,
    upstreamCall: upstreamCall || undefined,
    upstreamReply: upstream?.body,
    location: [...new Set(location)].slice(0, 4),
    cause: likelyCause(status, summaries.map((summary) => summary.message).join(' ')),
  };
}
