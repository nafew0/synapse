import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { servicePricingSchema } from 'librechat-data-provider';
import type { TServicePricingConfig, TServicePricingInput } from 'librechat-data-provider';
import type { TaskType, TransactionService } from '@librechat/data-schemas';
import { CREDITS_PER_USD } from './packages';

const DUPLICATE_KEY_ERROR_CODE = 11000;
const CHARS_PER_TOKEN = 4;

/** The services billed outside the model price table; model calls have their own rows. */
export type ChargedService = Exclude<TransactionService, 'openrouter'>;

export interface ServiceChargeInput {
  service: ChargedService;
  /** What was bought: `web_search`, `web_scrape`, `voice`, `embedding`, `ocr`. Stored as `usageKind` and `context`. */
  usageKind: string;
  usageUnit: 'tokens' | 'seconds' | 'operations';
  /** How many units the provider billed: credits, seconds, tokens or pages. Zero or less writes nothing. */
  units: number;
  unitPriceUsd: number;
  user: string;
  tenantId?: string;
  /** False for platform cost (indexing, memory) that never draws down an allowance. */
  billable?: boolean;
  /** Set when the charge is a task of its own, like a voice clip; chat requests are tagged when they settle. */
  taskType?: TaskType;
  /** Stable across retries of the same call, so a replay is recorded once. */
  requestKey: string;
  conversationId?: string;
  messageId?: string;
  fileId?: string;
  pages?: number;
  modelKey?: string;
}

export interface ServiceChargeResult {
  recorded: boolean;
  costUsd: number;
  /** Cost in credits (USD × 1e6) */
  credits: number;
}

/** Applies the schema's defaults to the `servicePricing` block, which the app config holds as written. */
export function resolveServicePricing(config?: TServicePricingInput): TServicePricingConfig {
  const parsed = servicePricingSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : servicePricingSchema.parse({});
}

/** Rough token count for text we only see as characters, as the plan sets it: characters ÷ 4. */
export const estimateTokens = (chars: number): number =>
  Math.ceil(Math.max(chars, 0) / CHARS_PER_TOKEN);

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === DUPLICATE_KEY_ERROR_CODE;
}

/**
 * Writes one ledger row for a paid service call. Not a token row: `tokenType: 'credits'` keeps it
 * out of the token aggregates and the balance is left alone. The cost is fixed here from the price
 * passed in. A replay with the same `requestKey` is ignored. Never throws, so a failed write cannot
 * fail the user's request.
 */
export async function recordServiceCharge(input: ServiceChargeInput): Promise<ServiceChargeResult> {
  const none: ServiceChargeResult = { recorded: false, costUsd: 0, credits: 0 };
  const { units, unitPriceUsd } = input;
  if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(unitPriceUsd)) {
    return none;
  }
  const costUsd = units * unitPriceUsd;
  const credits = Math.round(costUsd * CREDITS_PER_USD);
  const modelKey = input.modelKey ?? `${input.service}/${input.usageKind}`;
  try {
    await mongoose.models.Transaction.create({
      user: input.user,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      fileId: input.fileId,
      pages: input.pages,
      tokenType: 'credits',
      tokenValue: -credits,
      rawAmount: units,
      costUsd,
      context: input.usageKind,
      usageKind: input.usageKind,
      usageUnit: input.usageUnit,
      service: input.service,
      billable: input.billable ?? true,
      taskType: input.taskType,
      model: modelKey,
      modelKey,
      providerKey: input.service,
      requestKey: input.requestKey,
    });
    return { recorded: true, costUsd, credits };
  } catch (error) {
    if (isDuplicateKey(error)) {
      return none;
    }
    logger.error(`[Usage] Failed to record ${input.service} charge`, error);
    return none;
  }
}

/** Firecrawl bills a search 2 credits per 10 results asked for. */
export const firecrawlSearchCredits = (resultsRequested: number): number =>
  2 * Math.ceil(Math.max(resultsRequested, 0) / 10);

/** Firecrawl bills a scrape 1 credit, plus 1 for each PDF page it parsed. */
export const firecrawlScrapeCredits = (pdfPages = 0): number => 1 + Math.max(pdfPages, 0);

export interface OcrChargeInput {
  user: string;
  tenantId?: string;
  /** The uploaded file, so a retried upload is recorded once. */
  fileId: string;
  pages: number;
  pricePerPageUsd: number;
  /** Names the recogniser, e.g. `upload/mistral_ocr`. */
  modelKey: string;
  conversationId?: string;
}

/** The ledger key of an upload's OCR charge; the allowance meter charges under the same key. */
export const ocrRequestKey = (user: string, fileId: string): string =>
  `ocr-upload:${user}:${fileId}`;

/** Records pages read by the recogniser at upload time, the same way `read_document` records them. */
export function recordOcrCharge(input: OcrChargeInput): Promise<ServiceChargeResult> {
  return recordServiceCharge({
    service: 'unstructured',
    usageKind: 'ocr',
    usageUnit: 'operations',
    units: input.pages,
    unitPriceUsd: input.pricePerPageUsd,
    user: input.user,
    tenantId: input.tenantId,
    fileId: input.fileId,
    pages: input.pages,
    modelKey: input.modelKey,
    conversationId: input.conversationId,
    requestKey: ocrRequestKey(input.user, input.fileId),
  });
}
