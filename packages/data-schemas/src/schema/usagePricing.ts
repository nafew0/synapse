import { Schema } from 'mongoose';
import type { IUsagePricing } from '~/types';

const usagePricingSchema: Schema<IUsagePricing> = new Schema<IUsagePricing>(
  {
    key: { type: String, required: true, default: 'default', immutable: true },
    bdtPerUsd: { type: Number, required: true, min: 1 },
    providerFeePercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    defaultWeeklyPercent: { type: Number, required: true, default: 35, min: 1, max: 100 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

usagePricingSchema.index({ key: 1 }, { unique: true });

export default usagePricingSchema;
