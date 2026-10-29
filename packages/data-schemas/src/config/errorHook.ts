import winston from 'winston';
import { getRequestId, getRequestPath, getTenantId, getUserId } from './tenantContext';

/** The outgoing call that failed, when the logged error came from an HTTP client (e.g. axios). */
export type TUpstreamCall = {
  status?: number;
  method?: string;
  url?: string;
  body?: string;
};

/** An error logged while serving a request, as seen by the registered hook. */
export type TLoggedError = {
  message: string;
  stack?: string;
  requestId: string;
  userId?: string;
  tenantId?: string;
  path?: string;
  upstream?: TUpstreamCall;
};

type TErrorLogHook = (entry: TLoggedError) => void;

type TRequestInfo = { method?: string; url?: string };
type TResponseInfo = { status?: number; data?: string | object };

/** Set on a log entry whose error was already captured by the caller (e.g. `toPublicError`). */
export const SKIP_ERROR_HOOK: string = 'skipErrorHook';

const UPSTREAM_BODY_MAX = 500;

let errorLogHook: TErrorLogHook | undefined;

/**
 * Registers a callback for every `error`-level log written inside a request,
 * so request errors can be correlated by request id (used for issue reports).
 */
export function setErrorLogHook(hook: TErrorLogHook | undefined): void {
  errorLogHook = hook;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const asObject = <T extends object>(value: unknown): T | undefined =>
  value != null && typeof value === 'object' ? (value as T) : undefined;

function renderBody(body: unknown): string | undefined {
  if (body == null) {
    return undefined;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text ? text.slice(0, UPSTREAM_BODY_MAX) : undefined;
}

function withoutQuery(url?: string): string | undefined {
  return url?.split('?')[0];
}

/** Reads the failed HTTP call from fields axios errors (and `logAxiosError`) put on the log entry. */
function extractUpstream(info: winston.Logform.TransformableInfo): TUpstreamCall | undefined {
  const requestInfo =
    asObject<TRequestInfo>(info.requestInfo) ?? asObject<TRequestInfo>(info.config);
  const response = asObject<TResponseInfo>(info.response);
  const status = [info.status, response?.status].find(
    (value): value is number => typeof value === 'number',
  );
  const url = withoutQuery(asString(requestInfo?.url));
  if (status === undefined && !url) {
    return undefined;
  }
  return {
    status,
    method: asString(requestInfo?.method)?.toUpperCase(),
    url,
    body: renderBody(info.data ?? response?.data),
  };
}

/** Logger-level format: runs once per log entry, before any transport formats. */
export const errorHookFormat: winston.Logform.FormatWrap = winston.format((info) => {
  if (!errorLogHook || info.level !== 'error' || info[SKIP_ERROR_HOOK] === true) {
    return info;
  }
  const requestId = getRequestId();
  if (!requestId) {
    return info;
  }
  try {
    errorLogHook({
      message: typeof info.message === 'string' ? info.message : String(info.message),
      stack: typeof info.stack === 'string' ? info.stack : undefined,
      requestId,
      userId: getUserId(),
      tenantId: getTenantId(),
      path: getRequestPath(),
      upstream: extractUpstream(info),
    });
  } catch {
    /* a failing hook must never break logging */
  }
  return info;
});
