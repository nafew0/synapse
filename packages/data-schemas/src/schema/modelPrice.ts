import { Schema } from 'mongoose';
import type {
  IModelPrice,
  IModelPriceVersion,
  IModelPriceChange,
  IModelPriceSync,
} from '~/types/modelPrice';

const tierSchema = new Schema(
  {
    minPromptTokens: { type: Number, required: true },
    prompt: { type: Number, required: true },
    completion: { type: Number, required: true },
    cacheRead: Number,
    cacheWrite: Number,
    cacheWrite1h: Number,
  },
  { _id: false },
);

const priceBlock = {
  prompt: { type: Number, required: true },
  completion: { type: Number, required: true },
  cacheRead: Number,
  cacheWrite: Number,
  cacheWrite1h: Number,
  reasoning: Number,
  image: Number,
  imageOutput: Number,
  audio: Number,
  audioOutput: Number,
  webSearch: Number,
  contextLength: Number,
  tiers: { type: [tierSchema], default: [] },
};

const priceSchemaType = new Schema(priceBlock, { _id: false });

const diffLine = new Schema(
  {
    field: { type: String, required: true },
    previous: { type: Number, default: null },
    current: { type: Number, default: null },
    change: { type: Number, default: null },
    changePct: { type: Number, default: null },
    kind: { type: String, enum: ['changed', 'added', 'removed', 'unchanged'], required: true },
  },
  { _id: false },
);

/** Prices are platform-wide, so none of these collections is tenant-scoped. */
export const modelPriceSchema: Schema<IModelPrice> = new Schema(
  {
    modelId: { type: String, required: true, unique: true },
    aliases: { type: [String], default: [], index: true },
    name: String,
    kind: { type: String, enum: ['chat', 'embedding'], default: 'chat' },
    price: { type: priceSchemaType },
    override: {
      type: new Schema(
        {
          price: { type: priceSchemaType, required: true },
          reason: { type: String, required: true },
          setBy: String,
          setAt: { type: Date, required: true },
          until: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    status: { type: String, enum: ['ok', 'not_listed', 'no_price'], default: 'no_price' },
    usedFor: { type: [String], default: [] },
    fetchedAt: Date,
    lastChangedAt: Date,
    version: { type: Number, default: 0 },
    unpricedHits: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const modelPriceVersionSchema: Schema<IModelPriceVersion> = new Schema(
  {
    modelId: { type: String, required: true },
    version: { type: Number, required: true },
    effectiveFrom: { type: Date, required: true },
    source: {
      type: String,
      enum: ['sync', 'sync_now', 'override_set', 'override_cleared'],
      required: true,
    },
    priceSource: { type: String, enum: ['openrouter', 'manual'], required: true },
    price: { type: priceSchemaType, required: true },
    previous: { type: priceSchemaType, default: null },
    diff: { type: [diffLine], default: [] },
    actor: String,
    note: String,
  },
  { timestamps: true },
);
modelPriceVersionSchema.index({ modelId: 1, version: -1 }, { unique: true });

export const modelPriceChangeSchema: Schema<IModelPriceChange> = new Schema(
  {
    modelId: { type: String, required: true },
    kind: {
      type: String,
      enum: ['price_changed', 'unpriced', 'not_listed', 'sync_failing'],
      required: true,
    },
    version: Number,
    summary: { type: String, required: true },
    diff: { type: [diffLine], default: [] },
    seenAt: { type: Date, default: null },
    seenBy: String,
  },
  { timestamps: true },
);
modelPriceChangeSchema.index({ createdAt: -1 });
modelPriceChangeSchema.index({ modelId: 1, kind: 1, seenAt: 1 });

export const modelPriceSyncSchema: Schema<IModelPriceSync> = new Schema(
  {
    trigger: { type: String, enum: ['startup', 'timer', 'manual'], required: true },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    ok: { type: Boolean, default: false },
    models: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
    notListed: { type: Number, default: 0 },
    unpriced: { type: Number, default: 0 },
    error: String,
    actor: String,
  },
  { timestamps: true },
);
modelPriceSyncSchema.index({ startedAt: -1 });
