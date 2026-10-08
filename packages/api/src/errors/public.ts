import { randomUUID } from 'crypto';
import { CacheKeys, PublicErrorCodes } from 'librechat-data-provider';
import {
  logger,
  redactMessage,
  tenantStorage,
  setErrorLogHook,
  SKIP_ERROR_HOOK,
} from '@librechat/data-schemas';
import type { TLoggedError } from '@librechat/data-schemas';
import type { TPublicError } from 'librechat-data-provider';
import type { Keyv } from 'keyv';
import type { TTypedError } from './classify';
import { classifyError, extractTypedError, isAbortError } from './classify';
import { standardCache } from '~/cache';

const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_MESSAGE_MAX = 1000;
const SUMMARY_STACK_LINES = 4;
const MAX_SUMMARIES_PER_REQUEST = 5;

export type TErrorContext = {
  requestId?: string;
  userId?: string;
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
  agentId?: string;
  streamId?: string;
  route?: string;
  provider?: string;
  model?: string;
};

/** Redacted, server-side-only summary attached to issue reports. Never sent to the reporting user's UI. */
export type TErrorSummary = {
  requestId: string;
  userId?: string;
  code: string;
  status?: number;
  message: string;
  stack?: string;
  route?: string;
  provider?: string;
  model?: string;
  conversationId?: string;
  agentId?: string;
  at: string;
};

/** The public error plus any typed fields the client already renders (e.g. token balance numbers). */
export type TPublicErrorPayload = TPublicError & { typed?: TTypedError };

let summaryCache: Keyv | undefined;

function getSummaryCache(): Keyv {
  if (!summaryCache) {
    summaryCache = standardCache(CacheKeys.ERROR_SUMMARIES, SUMMARY_TTL_MS);
  }
  return summaryCache;
}

function summaryKey(requestId: string): string {
  return `summaries:${requestId}`;
}

/** Serializes appends per request id so concurrent errors in one request don't overwrite each other. */
const pendingAppends = new Map<string, Promise<void>>();

function appendSummary(summary: TErrorSummary): void {
  const key = summaryKey(summary.requestId);
  const previous = pendingAppends.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      const cache = getSummaryCache();
      const existing = ((await cache.get(key)) as TErrorSummary[] | undefined) ?? [];
      await cache.set(key, [...existing, summary].slice(-MAX_SUMMARIES_PER_REQUEST));
    })
    .catch((cacheError: Error) =>
      logger.warn('[publicError] Failed to cache error summary', cacheError.message),
    )
    .finally(() => {
      if (pendingAppends.get(key) === next) {
        pendingAppends.delete(key);
      }
    });
  pendingAppends.set(key, next);
}

function trimStack(stack?: string): string | undefined {
  return stack
    ? redactMessage(stack.split('\n').slice(0, SUMMARY_STACK_LINES).join('\n'))
    : undefined;
}

type TErrorFields = { message?: string; stack?: string; status?: number; statusCode?: number };

function getErrorParts(error: unknown): { message: string; stack?: string; status?: number } {
  if (typeof error === 'string') {
    return { message: error };
  }
  if (error == null || typeof error !== 'object') {
    return { message: String(error) };
  }
  const fields = error as TErrorFields;
  return {
    message:
      typeof fields.message === 'string'
        ? fields.message
        : (JSON.stringify(error) ?? String(error)),
    stack: typeof fields.stack === 'string' ? fields.stack : undefined,
    status: fields.status ?? fields.statusCode,
  };
}

function buildSummary(
  requestId: string,
  code: string,
  error: unknown,
  ctx: TErrorContext,
): TErrorSummary {
  const { message, stack, status } = getErrorParts(error);
  return {
    requestId,
    userId: ctx.userId,
    code,
    status,
    message: redactMessage(message, SUMMARY_MESSAGE_MAX),
    stack: trimStack(stack),
    route: ctx.route,
    provider: ctx.provider,
    model: ctx.model,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    at: new Date().toISOString(),
  };
}

function resolveContext(ctx: TErrorContext): TErrorContext & { requestId: string } {
  const store = tenantStorage.getStore();
  return {
    ...ctx,
    requestId: ctx.requestId ?? store?.requestId ?? randomUUID(),
    userId: ctx.userId ?? store?.userId,
    tenantId: ctx.tenantId ?? store?.tenantId,
  };
}

/**
 * Converts any thrown value into a user-safe `{ code, requestId }`.
 * Logs the full error once and keeps a redacted summary (7 days) so an issue
 * report for this request id can include the real cause for support staff.
 */
export function toPublicError(error: unknown, ctx: TErrorContext = {}): TPublicErrorPayload {
  const resolved = resolveContext(ctx);
  const typed = extractTypedError(error);
  const code = typed?.type ?? classifyError(error);
  const { requestId } = resolved;

  if (isAbortError(error)) {
    logger.debug(`[publicError] aborted (request_id=${requestId})`);
    return { code, requestId };
  }

  logger.error(`[publicError] ${code} (request_id=${requestId})`, {
    ...resolved,
    error: getErrorParts(error),
    [SKIP_ERROR_HOOK]: true,
  });

  appendSummary(buildSummary(requestId, code, error, resolved));

  return typed ? { code, requestId, typed } : { code, requestId };
}

/**
 * Serializes a public error into the JSON text the chat UI parses
 * (`Error.tsx` reads `type`). Typed fields are preserved for known error types.
 */
export function toChatErrorText(publicError: TPublicErrorPayload): string {
  return JSON.stringify({
    ...(publicError.typed ?? {}),
    type: publicError.code,
    requestId: publicError.requestId,
  });
}

/** Convenience: classify, log and serialize in one call for stream/content-part sites. */
export function toChatError(error: unknown, ctx: TErrorContext = {}): string {
  return toChatErrorText(toPublicError(error, ctx));
}

/**
 * Returns the cached summaries for a request that belong to `userId`,
 * so users cannot read other users' errors.
 */
export async function getErrorSummaries(
  requestId: string,
  userId: string,
): Promise<TErrorSummary[]> {
  try {
    const summaries = (await getSummaryCache().get(summaryKey(requestId))) as
      | TErrorSummary[]
      | undefined;
    return (summaries ?? []).filter((summary) => summary.userId === userId);
  } catch (error) {
    logger.warn('[publicError] Failed to read error summary', (error as Error).message);
    return [];
  }
}

function summarizeLoggedError(entry: TLoggedError): TErrorSummary {
  return {
    requestId: entry.requestId,
    userId: entry.userId,
    code: classifyError({ message: entry.message }),
    message: redactMessage(entry.message, SUMMARY_MESSAGE_MAX),
    stack: trimStack(entry.stack),
    route: entry.path,
    at: new Date().toISOString(),
  };
}

/**
 * Captures every error logged while serving an authenticated request, so an
 * issue report for that request id includes it — even on routes that log
 * their own errors instead of using `toPublicError`. Call once at startup.
 */
export function captureLoggedErrors(): void {
  setErrorLogHook((entry) => {
    if (entry.userId) {
      appendSummary(summarizeLoggedError(entry));
    }
  });
}

/** Builds an HTTP JSON body for an error response. */
export function toPublicErrorBody(
  error: unknown,
  ctx: TErrorContext = {},
  fallbackCode?: PublicErrorCodes,
): TPublicError {
  const { code, requestId } = toPublicError(error, ctx);
  if (fallbackCode && code === PublicErrorCodes.UNKNOWN) {
    return { code: fallbackCode, requestId };
  }
  return { code, requestId };
}
