/**
 * Classification of quota failures. Pure — no database, no models — so it can be
 * required from a request controller without dragging the quota service (and its
 * model and mailer dependencies) into that module's load graph.
 */

/** Shape the quota engine attaches to a refusal. */
interface QuotaErrorLike {
  details?: { code?: string };
}

/**
 * Codes that must reach the caller as a refusal. Everything else raised by the
 * quota engine is an availability problem: chat must keep working, because a
 * shadow-mode institution has not opted into having requests blocked at all.
 */
export const FAIL_CLOSED_QUOTA_CODES: ReadonlySet<string> = new Set([
  'TOKEN_QUOTA_EXCEEDED',
  'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
]);

/** Whether this error is a deliberate quota refusal rather than a failure. */
export function isEnforcementDenial(error: unknown): boolean {
  const code = (error as QuotaErrorLike | null | undefined)?.details?.code;
  return code != null && FAIL_CLOSED_QUOTA_CODES.has(code);
}
