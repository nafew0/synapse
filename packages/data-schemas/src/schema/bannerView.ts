import { Schema } from 'mongoose';
import type { IBannerView } from '~/types/banner';

const bannerViewSchema: Schema<IBannerView> = new Schema<IBannerView>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    bannerId: {
      type: String,
      required: true,
      maxlength: 128,
    },
    seenAt: {
      type: Date,
    },
    dismissedAt: {
      type: Date,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

/**
 * One doc per (user, banner) so repeated seen/dismiss calls stay idempotent.
 * `tenantId` is left out on purpose: user ObjectIds are globally unique.
 */
bannerViewSchema.index({ user: 1, bannerId: 1 }, { unique: true });

export default bannerViewSchema;
