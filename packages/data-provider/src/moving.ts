/** The server's answer while a member move re-scopes the account: retry, do not sign out. */
export const ACCOUNT_MOVING_CODE = 'ACCOUNT_MOVING';
/** Window event fired each time a request is held back because the account is moving. */
export const ACCOUNT_MOVING_EVENT = 'accountMoving';
/** How often one request is retried, and the longest single wait, while the account moves. */
export const ACCOUNT_MOVING_MAX_RETRIES = 6;
export const ACCOUNT_MOVING_MAX_WAIT_MS = 10_000;
/** How long a request keeps being resent while the server says the account is moving. */
export const ACCOUNT_MOVING_MAX_TOTAL_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 5_000;

interface MaybeMovingError {
  response?: { status?: number; data?: { code?: string } | null } | null;
}

/** Whether a failed request was turned away because the account is moving to another institution. */
export function isAccountMovingError(error: unknown): boolean {
  const response = (error as MaybeMovingError | null)?.response;
  return response?.status === 503 && response.data?.code === ACCOUNT_MOVING_CODE;
}

/** The wait a `Retry-After` header asks for (seconds), capped; a default when absent or odd. */
export function accountMovingWaitMs(retryAfter: unknown): number {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(seconds * 1000, ACCOUNT_MOVING_MAX_WAIT_MS);
}

/** Whether a response body (parsed or raw text) is the `ACCOUNT_MOVING` refusal. */
export function isAccountMovingBody(body: unknown): boolean {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return false;
    }
  }
  return (data as { code?: unknown } | null)?.code === ACCOUNT_MOVING_CODE;
}

/** Tells the page (the notice, the user query) that a request is being held back. */
export function announceAccountMoving(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACCOUNT_MOVING_EVENT));
  }
}
