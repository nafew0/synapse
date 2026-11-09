import { ErrorTypes, PublicErrorCodes } from 'librechat-data-provider';
import { getErrorInfo } from '~/utils/errors';

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

/** The institution's message on a `chat_access_ended` refusal: written by a platform admin, not a provider. */
function accessEndedInfo(raw: unknown): string | undefined {
  let body = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const info = (body as { info?: unknown } | null)?.info;
  return typeof info === 'string' && info.trim() ? info : undefined;
}

/**
 * Reduces any error payload (HTTP body, SSE event, thrown error, legacy raw text) to the
 * JSON text `{"type": code, "requestId"?}` that the chat error box renders. Raw text never passes;
 * the one extra field is the admin-written `info` of a `chat_access_ended` refusal.
 */
export function toErrorText(payload: unknown): string {
  const raw = unwrapPayload(payload);
  const { code, requestId } = getErrorInfo(raw);
  const info = code === ErrorTypes.CHAT_ACCESS_ENDED ? accessEndedInfo(raw) : undefined;
  return JSON.stringify({
    type: code,
    ...(requestId != null && { requestId }),
    ...(info != null && { info }),
  });
}
