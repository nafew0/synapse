import mongoose, { Schema, Document, Types } from 'mongoose';

/** Which paid provider a ledger row was billed by. Rows written before this field existed have none. */
export const TRANSACTION_SERVICES = [
  'openrouter',
  'unstructured',
  'firecrawl',
  'stt',
  'embeddings',
] as const;

export type TransactionService = (typeof TRANSACTION_SERVICES)[number];

/** What a request was for, decided from what it did when it settled. */
export const TASK_TYPES = [
  'chat',
  'file_question',
  'word',
  'excel',
  'powerpoint',
  'pdf_edit',
  'pdf_to_word',
  'scan_to_word',
  'email',
  'web_search',
  'research_document',
  'image',
  'voice',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
  model?: string;
  modelKey?: string;
  providerKey?: string;
  providerModelId?: string;
  context?: string;
  usageKind?: string;
  usageUnit?: 'tokens' | 'images' | 'seconds' | 'operations';
  /** Provider that billed this row; see {@link TRANSACTION_SERVICES}. */
  service?: TransactionService;
  /** False for platform cost (memory, indexing) that never draws down an allowance. Absent means billable. */
  billable?: boolean;
  /** Kind of task the request was; see {@link TASK_TYPES}. Set when the request settles. */
  taskType?: TaskType;
  requestKey?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  pages?: number;
  costUsd?: number;
  /** `provider` when `costUsd` is the amount the provider reported for the call, not a price-table figure. */
  costSource?: 'provider';
  fileId?: string;
  tenantId?: string;
  /** Set once a cost-correction script has repriced this row; holds the values it replaced. */
  costCorrection?: CostCorrection;
}

export interface CostCorrection {
  /** Which correction ran, e.g. `haiku-5.5-long-prompt-tier`. */
  id: string;
  runId: string;
  at: Date;
  previousTokenValue: number;
  previousRate: number;
}

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    modelKey: {
      type: String,
      index: true,
    },
    providerKey: {
      type: String,
      index: true,
    },
    providerModelId: {
      type: String,
    },
    context: {
      type: String,
    },
    usageKind: {
      type: String,
      index: true,
    },
    usageUnit: {
      type: String,
      enum: ['tokens', 'images', 'seconds', 'operations'],
      default: 'tokens',
    },
    service: {
      type: String,
      enum: TRANSACTION_SERVICES,
    },
    billable: {
      type: Boolean,
    },
    taskType: {
      type: String,
      enum: TASK_TYPES,
    },
    requestKey: {
      type: String,
      index: true,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    pages: { type: Number },
    costUsd: { type: Number },
    costSource: { type: String, enum: ['provider'] },
    fileId: { type: String },
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    tenantId: {
      type: String,
      index: true,
    },
    costCorrection: {
      type: {
        _id: false,
        id: { type: String, required: true },
        runId: { type: String, required: true },
        at: { type: Date, required: true },
        previousTokenValue: { type: Number, required: true },
        previousRate: { type: Number, required: true },
      },
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

transactionSchema.index({ tenantId: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, user: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, modelKey: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, providerKey: 1, createdAt: -1 });
transactionSchema.index({ service: 1, createdAt: -1 });
transactionSchema.index({ createdAt: 1 });
transactionSchema.index({ taskType: 1, createdAt: -1 });

/**
 * Ledger idempotency key (P1-3). A retried usage write carries the same
 * natural key and is rejected as a duplicate, so it is recorded exactly once
 * and never double-charges the balance. Partial so it constrains only rows
 * that actually carry a `requestKey` — legacy/keyless rows are unaffected, and
 * so the index can be built without a historical de-duplication pass.
 * Before enabling in an existing deployment, run `reportDuplicateRequestKeys`
 * to confirm no live duplicates exist.
 */
transactionSchema.index(
  { tenantId: 1, requestKey: 1, tokenType: 1, valueKey: 1 },
  {
    unique: true,
    partialFilterExpression: { requestKey: { $type: 'string' } },
    name: 'transaction_idempotency_key',
  },
);

export default transactionSchema;
