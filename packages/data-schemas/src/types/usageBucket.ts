import type { Document, Types } from 'mongoose';

/**
 * `member_images` counts IMAGES, not tokens, in `usedTokens`/`reservedTokens`.
 * A separate `unit` field was deliberately avoided: it would belong in the
 * `usage_bucket_scope_period` unique index and force an index migration on a
 * live collection, whereas `scopeType` is already part of that key.
 */
export type UsageBucketScope =
  | 'institution'
  | 'member'
  | 'model'
  | 'member_images'
  | 'institution_credits'
  | 'member_credits';

export interface IUsageBucket extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  scopeType: UsageBucketScope;
  scopeKey: string;
  policyVersion: number;
  /** Weighted tokens; image count for `member_images`; credits (USD × 1e6) for `*_credits`. */
  usedTokens: number;
  reservedTokens: number;
  createdAt?: Date;
  updatedAt?: Date;
}
