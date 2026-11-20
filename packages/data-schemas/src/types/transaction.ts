import type { TransactionService } from '~/schema/transaction';

export interface TransactionData {
  user: string;
  tenantId?: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  modelKey?: string;
  providerKey?: string;
  providerModelId?: string;
  context?: string;
  usageKind?: string;
  usageUnit?: 'tokens' | 'images' | 'seconds' | 'operations';
  service?: TransactionService;
  billable?: boolean;
  requestKey?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
  /** USD the provider reported for the call; see `costSource`. */
  costUsd?: number;
  costSource?: 'provider';
}
