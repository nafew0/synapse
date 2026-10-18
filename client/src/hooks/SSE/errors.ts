import { ErrorTypes, PublicErrorCodes } from 'librechat-data-provider';
import { getErrorInfo } from '~/utils/errors';
import { extractJson } from '~/utils/json';

type TErrorEnvelope = {
  error?: unknown;
  text?: unknown;
};

/** Text stored on a response when the client lost its connection to the server. */
export const CONNECTION_ERROR_TEXT = JSON.stringify({ type: PublicErrorCodes.CONNECTION_LOST });

/** Sentinel written by older clients; still found on locally cached messages. */
export const LEGACY_CONNECTION_ERROR_TEXT = 'Error connecting to server, try refreshing the page.';

/** SSE error events wrap the job's stored error JSON as `{ error: "<json>" }`. */
function unwrapPayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') {
    return payload;
  }
  const { error, text } = payload as TErrorEnvelope;
  if (typeof error === 'string' || (error != null && typeof error === 'object')) {
    return error;
  }
  if (typeof text === 'string') {
    return text;
  }
  return payload;
}

/** What a usage-limit notice needs to name the allowance and its reset; all set by the server. */
const QUOTA_DISPLAY_FIELDS = ['limitCode', 'window', 'meter', 'resetAt'] as const;

type TQuotaDisplay = Partial<Record<(typeof QUOTA_DISPLAY_FIELDS)[number], string>>;

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value != null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(extractJson(value) || value);
    return parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The display fields of a usage-limit refusal, so the live notice can name the wall and its reset. */
function quotaDisplay(code: string, payload: unknown): TQuotaDisplay {
  if (code !== ErrorTypes.TOKEN_QUOTA_EXCEEDED) {
    return {};
  }
  const body = parseObject(payload);
  const display: TQuotaDisplay = {};
  for (const field of QUOTA_DISPLAY_FIELDS) {
    const value = body?.[field];
    if (typeof value === 'string') {
      display[field] = value;
    }
  }
  return display;
}

/**
 * Reduces any error payload (HTTP body, SSE event, thrown error, legacy raw text) to the
 * JSON text `{"type": code, "requestId"?}` that the chat error box renders. Raw text never
 * passes; a usage-limit refusal also keeps its display fields (limit, window, reset).
 */
export function toErrorText(payload: unknown): string {
  const unwrapped = unwrapPayload(payload);
  const { code, requestId } = getErrorInfo(unwrapped);
  return JSON.stringify({
    type: code,
    ...quotaDisplay(code, unwrapped),
    ...(requestId != null && { requestId }),
  });
}
