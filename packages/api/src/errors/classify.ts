import { ErrorTypes, ViolationTypes, PublicErrorCodes } from 'librechat-data-provider';

export type TErrorLike = {
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  type?: string;
  error?: { message?: string; type?: string; code?: string | number } | string;
  response?: { status?: number };
  cause?: TErrorLike;
};

/** JSON-safe value carried in a typed error payload. */
export type TErrorDetail = string | number | boolean | null;

/** A typed error the client already knows how to render (e.g. `token_balance`). */
export type TTypedError = { type: string } & { [key: string]: TErrorDetail };

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TOOLS_UNAVAILABLE_CODES = new Set(['AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE']);

const CONTEXT_PATTERN =
  /context[_ ]length|maximum context|context window|prompt is too long|too many tokens|reduce the length|input is too long|exceeds the maximum/i;
const FILTER_PATTERN =
  /content[_ ]?filter|content management policy|responsible ai policy|flagged by|safety (?:system|settings)/i;
const QUOTA_PATTERN = /insufficient[_ ]quota|insufficient credits|billing|payment required/i;
const BUSY_PATTERN = /rate[_ ]?limit|too many requests|overloaded|capacity|server is busy/i;
const AUTH_PATTERN =
  /api[_ -]?key|unauthori[sz]ed|authentication|invalid x-api-key|permission denied|no auth credentials/i;
const MODEL_PATTERN = /model/i;
const NETWORK_PATTERN =
  /network|socket hang up|fetch failed|terminated|timed? ?out|timeout|connection (?:error|closed|reset)|ECONN/i;
const TOOLS_PATTERN = /\[MCP\]|mcp server|tools? (?:are|is) unavailable/i;
const LEADING_STATUS = /^\s*(\d{3})\b/;

const typedErrorTypes = new Set<string>([
  ...Object.values(ErrorTypes),
  ...Object.values(ViolationTypes),
]);

/** Keys that must never be forwarded to the browser, even on known typed errors. */
const DROPPED_TYPED_KEYS = new Set(['generations', 'stack', 'message', 'error']);
const DROPPED_INFO_TYPES = new Set<string>([ErrorTypes.REFUSAL, ErrorTypes.GOOGLE_ERROR]);

function asErrorLike(error: unknown): TErrorLike | undefined {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  return error as TErrorLike;
}

function getMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  const like = asErrorLike(error);
  if (!like) {
    return '';
  }
  const nested = typeof like.error === 'string' ? like.error : (like.error?.message ?? '');
  return [like.message ?? '', nested].filter(Boolean).join(' ');
}

function getStatus(like: TErrorLike, message: string): number | undefined {
  const status = like.status ?? like.statusCode ?? like.response?.status;
  if (typeof status === 'number') {
    return status;
  }
  const match = LEADING_STATUS.exec(message);
  return match ? Number(match[1]) : undefined;
}

export function isAbortError(error: unknown): boolean {
  const like = asErrorLike(error);
  if (!like) {
    return false;
  }
  if (like.name === 'AbortError') {
    return true;
  }
  const message = like.message ?? '';
  return message === 'aborted' || /request was aborted|operation was aborted/i.test(message);
}

function parseJsonObject(text: string): { [key: string]: TErrorDetail | object } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as { [key: string]: TErrorDetail | object };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Returns the error as a typed payload when it already carries a known
 * `ErrorTypes`/`ViolationTypes` type (e.g. `token_balance`), keeping only flat,
 * non-sensitive fields the client renders.
 */
export function extractTypedError(error: unknown): TTypedError | undefined {
  const like = asErrorLike(error);
  if (like && typeof like.code === 'string' && typedErrorTypes.has(like.code)) {
    return { type: like.code };
  }
  const parsed = parseJsonObject(like?.message ?? (typeof error === 'string' ? error : ''));
  const type = parsed?.type;
  if (typeof type !== 'string' || !typedErrorTypes.has(type)) {
    return undefined;
  }
  const typed: TTypedError = { type };
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (key === 'type' || DROPPED_TYPED_KEYS.has(key)) {
      continue;
    }
    if (key === 'info' && DROPPED_INFO_TYPES.has(type)) {
      continue;
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      typed[key] = value as TErrorDetail;
    }
  }
  return typed;
}

/** Maps any thrown value to a user-safe error code. Pure: no logging, no I/O. */
export function classifyError(error: unknown): PublicErrorCodes {
  const like = asErrorLike(error) ?? {};
  const message = getMessage(error);
  const status = getStatus(like, message);
  const code = typeof like.code === 'string' ? like.code : undefined;

  if (isAbortError(error)) {
    return PublicErrorCodes.CONNECTION_LOST;
  }
  if (code && TOOLS_UNAVAILABLE_CODES.has(code)) {
    return PublicErrorCodes.TOOLS_UNAVAILABLE;
  }
  if (like.name === 'CastError') {
    return PublicErrorCodes.NOT_FOUND;
  }
  if (CONTEXT_PATTERN.test(message)) {
    return PublicErrorCodes.CONTEXT_TOO_LONG;
  }
  if (FILTER_PATTERN.test(message)) {
    return PublicErrorCodes.CONTENT_FILTERED;
  }
  if (status === 402 || QUOTA_PATTERN.test(message)) {
    return PublicErrorCodes.MODEL_UNAVAILABLE;
  }
  if (status === 429 || status === 529 || BUSY_PATTERN.test(message)) {
    return PublicErrorCodes.SERVICE_BUSY;
  }
  if (TOOLS_PATTERN.test(message)) {
    return PublicErrorCodes.TOOLS_UNAVAILABLE;
  }
  if (status === 401 || (status === 403 && AUTH_PATTERN.test(message))) {
    return PublicErrorCodes.MODEL_UNAVAILABLE;
  }
  if (status === 403) {
    return PublicErrorCodes.FORBIDDEN;
  }
  if (status === 404) {
    return MODEL_PATTERN.test(message)
      ? PublicErrorCodes.MODEL_UNAVAILABLE
      : PublicErrorCodes.NOT_FOUND;
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return PublicErrorCodes.SERVICE_UNAVAILABLE;
  }
  if ((code && NETWORK_CODES.has(code)) || NETWORK_PATTERN.test(message)) {
    return PublicErrorCodes.SERVICE_UNAVAILABLE;
  }
  if (status !== undefined && status >= 400) {
    return PublicErrorCodes.REQUEST_FAILED;
  }
  if (like.cause && like.cause !== like) {
    const causeCode = classifyError(like.cause);
    if (causeCode !== PublicErrorCodes.UNKNOWN) {
      return causeCode;
    }
  }
  return PublicErrorCodes.UNKNOWN;
}
