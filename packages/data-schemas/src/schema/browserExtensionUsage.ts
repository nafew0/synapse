import { Schema } from 'mongoose';
import type { IBrowserExtensionUsage } from '~/types';

/** Kept apart from `transaction`, so extension usage can never draw down quota by accident. */
const browserExtensionUsageSchema: Schema<IBrowserExtensionUsage> =
  new Schema<IBrowserExtensionUsage>({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: String },
    llmModel: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    at: { type: Date, required: true },
  });

browserExtensionUsageSchema.index({ user: 1, at: -1 });
browserExtensionUsageSchema.index({ tenantId: 1, at: -1 });

export default browserExtensionUsageSchema;
