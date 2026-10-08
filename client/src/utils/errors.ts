import axios from 'axios';
import { PublicErrorCodes, REQUEST_ID_HEADER, isRequestId } from 'librechat-data-provider';
import type { TIssueReportError } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { extractJson } from './json';

/**
 * Returns the HTTP response status code from an error, regardless of the
 * HTTP client used.  Handles Axios errors first, then falls back to checking
 * for a plain `status` property so callers never need to import axios.
 */
export const getResponseStatus = (error: unknown): number | undefined => {
  if (axios.isAxiosError(error)) {
    return error.response?.status;
  }
  if (error != null && typeof error === 'object' && 'status' in error) {
    const { status } = error as { status: unknown };
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
};

export const isNotFoundError = (error: unknown): boolean => getResponseStatus(error) === 404;

type LocalizeFn = (key: TranslationKeys, options?: Record<string, string>) => string;

export type TErrorInfo = {
  code: string;
  requestId?: string;
  status?: number;
};

type TErrorBody = {
  code?: string;
  type?: string;
  requestId?: string;
};

type TAxiosLike = {
  code?: string;
  message?: string;
  request?: object;
  response?: {
    status?: number;
    data?: TErrorBody | string;
    headers?: Record<string, string | undefined>;
  };
};

export const publicErrorKeys: Record<PublicErrorCodes, TranslationKeys> = {
  [PublicErrorCodes.SERVICE_BUSY]: 'com_error_service_busy',
  [PublicErrorCodes.SERVICE_UNAVAILABLE]: 'com_error_service_unavailable',
  [PublicErrorCodes.CONTEXT_TOO_LONG]: 'com_error_context_too_long',
  [PublicErrorCodes.CONTENT_FILTERED]: 'com_error_content_filtered',
  [PublicErrorCodes.MODEL_UNAVAILABLE]: 'com_error_model_unavailable',
  [PublicErrorCodes.TOOLS_UNAVAILABLE]: 'com_error_tools_unavailable',
  [PublicErrorCodes.CONNECTION_LOST]: 'com_error_connection_lost',
  [PublicErrorCodes.NOT_FOUND]: 'com_error_not_found',
  [PublicErrorCodes.FORBIDDEN]: 'com_error_forbidden',
  [PublicErrorCodes.REQUEST_FAILED]: 'com_error_request_failed',
  [PublicErrorCodes.REPORT_FAILED]: 'com_error_report_failed',
  [PublicErrorCodes.UNKNOWN]: 'com_error_unknown',
};

/** Codes whose own text is more useful than a feature-specific fallback message. */
const specificCodes = new Set<string>([
  PublicErrorCodes.SERVICE_BUSY,
  PublicErrorCodes.SERVICE_UNAVAILABLE,
  PublicErrorCodes.CONTEXT_TOO_LONG,
  PublicErrorCodes.CONTENT_FILTERED,
  PublicErrorCodes.MODEL_UNAVAILABLE,
  PublicErrorCodes.TOOLS_UNAVAILABLE,
  PublicErrorCodes.CONNECTION_LOST,
  PublicErrorCodes.NOT_FOUND,
  PublicErrorCodes.FORBIDDEN,
]);

function codeFromStatus(status?: number): PublicErrorCodes {
  if (status === undefined) {
    return PublicErrorCodes.UNKNOWN;
  }
  if (status === 403) {
    return PublicErrorCodes.FORBIDDEN;
  }
  if (status === 404) {
    return PublicErrorCodes.NOT_FOUND;
  }
  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return PublicErrorCodes.SERVICE_UNAVAILABLE;
  }
  if (status === 429) {
    return PublicErrorCodes.SERVICE_BUSY;
  }
  if (status >= 400 && status < 500) {
    return PublicErrorCodes.REQUEST_FAILED;
  }
  return PublicErrorCodes.UNKNOWN;
}

function parseBody(text: string): TErrorBody | undefined {
  const json = extractJson(text);
  if (!json) {
    return undefined;
  }
  try {
    const parsed: TErrorBody = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fromBody(body: TErrorBody | undefined, status?: number): TErrorInfo | undefined {
  const code = body?.code ?? body?.type;
  if (typeof code !== 'string' || !code) {
    return undefined;
  }
  return {
    code,
    status,
    requestId: isRequestId(body?.requestId) ? body?.requestId : undefined,
  };
}

/**
 * Extracts a safe `{ code, requestId }` from anything thrown or received: axios errors,
 * SSE payloads, JSON error text, or plain strings. Never exposes the raw message.
 */
export function getErrorInfo(error: unknown): TErrorInfo {
  if (typeof error === 'string') {
    return fromBody(parseBody(error)) ?? { code: PublicErrorCodes.UNKNOWN };
  }
  if (error == null || typeof error !== 'object') {
    return { code: PublicErrorCodes.UNKNOWN };
  }

  const axiosLike = error as TAxiosLike & TErrorBody;
  const response = axiosLike.response;
  if (response) {
    const data = typeof response.data === 'string' ? parseBody(response.data) : response.data;
    const headerId = response.headers?.[REQUEST_ID_HEADER];
    const info: TErrorInfo = fromBody(data, response.status) ?? {
      code: codeFromStatus(response.status),
      status: response.status,
      requestId: isRequestId(data?.requestId) ? data?.requestId : undefined,
    };
    if (!info.requestId && isRequestId(headerId)) {
      info.requestId = headerId;
    }
    return info;
  }

  if (axiosLike.code === 'ECONNABORTED' || axiosLike.code === 'ERR_NETWORK' || axiosLike.request) {
    return { code: PublicErrorCodes.SERVICE_UNAVAILABLE };
  }

  const direct = fromBody(axiosLike);
  if (direct) {
    return direct;
  }
  return fromBody(parseBody(axiosLike.message ?? '')) ?? { code: PublicErrorCodes.UNKNOWN };
}

function isPublicCode(code: string): code is PublicErrorCodes {
  return code in publicErrorKeys;
}

/**
 * Localized, user-safe message for an error. Specific conditions (busy, offline,
 * permission, not found…) use their own text; anything generic uses `fallbackKey`.
 */
export function getErrorMessage(
  error: unknown,
  localize: LocalizeFn,
  fallbackKey?: TranslationKeys,
): string {
  const { code } = getErrorInfo(error);
  if (specificCodes.has(code) && isPublicCode(code)) {
    return localize(publicErrorKeys[code]);
  }
  if (fallbackKey) {
    return localize(fallbackKey);
  }
  return localize(isPublicCode(code) ? publicErrorKeys[code] : 'com_error_unknown');
}

const MAX_RECENT_ERRORS = 5;
const RECENT_ERRORS_KEY = 'synapse:recentErrors';

function loadRecentErrors(): TIssueReportError[] {
  try {
    const stored = sessionStorage.getItem(RECENT_ERRORS_KEY);
    const parsed: TIssueReportError[] = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_ERRORS) : [];
  } catch {
    return [];
  }
}

function saveRecentErrors(errors: TIssueReportError[]): void {
  try {
    sessionStorage.setItem(RECENT_ERRORS_KEY, JSON.stringify(errors));
  } catch {
    /* storage unavailable (private mode, quota); the in-memory list still works */
  }
}

let recentErrors: TIssueReportError[] = loadRecentErrors();

/**
 * Remembers the last few errors (code, request id, time and path only — never message text)
 * for this browser tab, surviving reloads, so an issue report can include them.
 */
export function recordError(info: TErrorInfo): void {
  const page = typeof window !== 'undefined' ? window.location.pathname : undefined;
  const entry: TIssueReportError = {
    code: info.code.slice(0, 256),
    requestId: info.requestId,
    occurredAt: new Date().toISOString(),
    page: page?.slice(0, 256),
  };
  const isDuplicate = recentErrors.some(
    (existing) => existing.requestId != null && existing.requestId === entry.requestId,
  );
  if (isDuplicate) {
    return;
  }
  recentErrors = [entry, ...recentErrors].slice(0, MAX_RECENT_ERRORS);
  saveRecentErrors(recentErrors);
}

export function getRecentErrors(): TIssueReportError[] {
  return recentErrors;
}

export function clearRecentErrors(): void {
  recentErrors = [];
  saveRecentErrors(recentErrors);
}
