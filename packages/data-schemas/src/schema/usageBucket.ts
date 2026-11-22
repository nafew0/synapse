import { Schema } from 'mongoose';
import type { IUsageBucket } from '~/types';

const usageBucketSchema: Schema<IUsageBucket> = new Schema<IUsageBucket>(
  {
    tenantId: { type: String, required: true, trim: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    /** `member_images` counts images rather than tokens — see IUsageBucket. */
    scopeType: {
      type: String,
      enum: [
        'institution',
        'member',
        'model',
        'member_images',
        'institution_credits',
        'member_credits',
      ],
      required: true,
    },
    scopeKey: { type: String, required: true, trim: true },
    policyVersion: { type: Number, required: true, min: 1 },
    usedTokens: { type: Number, default: 0, min: 0 },
    reservedTokens: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

usageBucketSchema.index(
  { tenantId: 1, periodStart: 1, scopeType: 1, scopeKey: 1 },
  { unique: true, name: 'usage_bucket_scope_period' },
);
usageBucketSchema.index({ tenantId: 1, periodEnd: 1 });
/** The busiest members of a window, ranked in the database rather than in memory. */
usageBucketSchema.index({ tenantId: 1, scopeType: 1, periodStart: 1, usedTokens: -1 });

export default usageBucketSchema;
