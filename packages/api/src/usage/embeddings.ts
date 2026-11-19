import type { ServiceChargeResult } from './charges';
import type { ServerRequest } from '~/types';
import { estimateTokens, recordServiceCharge, resolveServicePricing } from './charges';

const TOKENS_PER_MILLION = 1_000_000;

export interface EmbeddingChargeInput {
  user: string;
  tenantId?: string;
  /** What the provider embedded, when the RAG API reports it; otherwise estimated from `chars`. */
  tokens?: number;
  chars?: number;
  /** `index` when a file is added to search, `query` when a search runs. */
  phase: 'index' | 'query';
  /** One id for one embedding job, stable across a retry: a file id, or a tool call id. */
  jobId: string;
  fileId?: string;
  conversationId?: string;
  pricePer1MTokensUsd: number;
}

/**
 * Records embedding spend. It is platform cost, never charged to an allowance (decision C2):
 * Synapse sends the text to the RAG API, which embeds it, so `billable` is always false.
 */
export function recordEmbeddingCharge(input: EmbeddingChargeInput): Promise<ServiceChargeResult> {
  const { tokens, chars = 0, phase, jobId } = input;
  return recordServiceCharge({
    service: 'embeddings',
    usageKind: `embedding_${phase}`,
    usageUnit: 'tokens',
    units: tokens ?? estimateTokens(chars),
    unitPriceUsd: input.pricePer1MTokensUsd / TOKENS_PER_MILLION,
    user: input.user,
    tenantId: input.tenantId,
    billable: false,
    fileId: input.fileId,
    conversationId: input.conversationId,
    requestKey: `embeddings:${phase}:${input.user}:${jobId}`,
  });
}

/** The user, tenant and embedding price for a request, or `undefined` when nobody is signed in. */
export function getEmbeddingBilling(
  req?: Pick<ServerRequest, 'user' | 'config'>,
): Pick<EmbeddingChargeInput, 'user' | 'tenantId' | 'pricePer1MTokensUsd'> | undefined {
  if (!req?.user?.id) {
    return undefined;
  }
  return {
    user: req.user.id,
    tenantId: req.user.tenantId,
    pricePer1MTokensUsd: resolveServicePricing(req.config?.servicePricing).embeddings
      .pricePer1MTokensUsd,
  };
}
