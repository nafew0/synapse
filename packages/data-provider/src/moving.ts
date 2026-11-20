/** The server's answer while a member move re-scopes the account: retry, do not sign out. */
export const ACCOUNT_MOVING_CODE = 'ACCOUNT_MOVING';
/** Window event fired each time a request is held back because the account is moving. */
export const ACCOUNT_MOVING_EVENT = 'accountMoving';
/** How often one request is retried, and the longest single wait, while the account moves. */
export const ACCOUNT_MOVING_MAX_RETRIES = 6;
export const ACCOUNT_MOVING_MAX_WAIT_MS = 10_000;
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
