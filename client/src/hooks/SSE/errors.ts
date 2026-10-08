import { PublicErrorCodes } from 'librechat-data-provider';
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

/**
 * Reduces any error payload (HTTP body, SSE event, thrown error, legacy raw text) to the
 * JSON text `{"type": code, "requestId"?}` that the chat error box renders. Raw text never passes.
 */
export function toErrorText(payload: unknown): string {
  const { code, requestId } = getErrorInfo(unwrapPayload(payload));
  return JSON.stringify(requestId != null ? { type: code, requestId } : { type: code });
}
