import winston from 'winston';
import { getRequestId, getRequestPath, getTenantId, getUserId } from './tenantContext';

/** An error logged while serving a request, as seen by the registered hook. */
export type TLoggedError = {
  message: string;
  stack?: string;
  requestId: string;
  userId?: string;
  tenantId?: string;
  path?: string;
};

type TErrorLogHook = (entry: TLoggedError) => void;

/** Set on a log entry whose error was already captured by the caller (e.g. `toPublicError`). */
export const SKIP_ERROR_HOOK: string = 'skipErrorHook';

let errorLogHook: TErrorLogHook | undefined;

/**
 * Registers a callback for every `error`-level log written inside a request,
 * so request errors can be correlated by request id (used for issue reports).
 */
export function setErrorLogHook(hook: TErrorLogHook | undefined): void {
  errorLogHook = hook;
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
    });
  } catch {
    /* a failing hook must never break logging */
  }
  return info;
});
