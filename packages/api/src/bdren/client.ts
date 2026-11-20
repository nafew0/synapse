import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import type { BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AllowanceFetch, BdrenConfig } from './types';

const windowSchema = z.object({ start: z.string(), end: z.string().nullable() });

const payloadSchema = z.object({
  product: z.string(),
  user: z.object({ subject: z.string(), email: z.string().optional() }),
  plan_source: z.enum(['free', 'personal', 'institution']),
  package: z.object({ slug: z.string(), name: z.string(), version: z.number() }).nullable(),
  institution: z
    .object({
      id: z.string(),
      slug: z.string().optional(),
      name: z.string().optional(),
      seats: z.number().nullable().optional(),
      seat_level: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  subscription: z
    .object({
      id: z.string(),
      status: z.string(),
      starts_at: z.string(),
      expires_at: z.string().nullable(),
    })
    .nullable(),
  limits: z.record(z.string(), z.record(z.string(), z.number())),
  limits_source: z.string().optional(),
  windows: z.record(z.string(), windowSchema),
  renews: z.string().optional(),
  upgrade_url: z.string().optional(),
  etag: z.string(),
});

/** Who to ask about. `idToken` is the raw token of a login just completed; bdren.ai may use it to learn a person it has not seen sign in. Never logged. */
export interface AllowanceIdentity {
  issuer: string;
  subject: string;
  idToken?: string;
}

export interface AllowanceClient {
  /** Asks bdren.ai what one person may use. Never throws: a failure is a result. */
  fetchAllowance: (identity: AllowanceIdentity, etag?: string) => Promise<AllowanceFetch>;
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Allowance client with a hard timeout. The product key goes only in the header, never in a log. */
export function createAllowanceClient(
  config: BdrenConfig,
  fetchFn: FetchFn = fetch,
): AllowanceClient {
  async function fetchAllowance(
    identity: AllowanceIdentity,
    etag?: string,
  ): Promise<AllowanceFetch> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Product-Api-Key': config.productKey,
    };
    if (etag) {
      headers['If-None-Match'] = `"${etag}"`;
    }
    try {
      const response = await fetchFn(`${config.baseUrl}/api/v1/entitlements/allowance/`, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          issuer: identity.issuer,
          zitadel_subject: identity.subject,
          ...(identity.idToken ? { id_token: identity.idToken } : null),
        }),
      });
      if (response.status === 304) {
        return { status: 'not_modified' };
      }
      if (response.status === 404) {
        return { status: 'not_found' };
      }
      if (!response.ok) {
        return { status: 'error', reason: `http_${response.status}` };
      }
      const parsed = payloadSchema.safeParse(await response.json());
      if (!parsed.success) {
        return { status: 'error', reason: 'invalid_payload' };
      }
      const payload: BdrenAllowancePayload = parsed.data;
      if (payload.user.subject !== identity.subject) {
        logger.error('[bdren] allowance answered for a different subject; ignored');
        return { status: 'error', reason: 'subject_mismatch' };
      }
      return { status: 'ok', payload };
    } catch (error) {
      const name = (error as Error)?.name;
      return { status: 'error', reason: name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }
  return { fetchAllowance };
}
