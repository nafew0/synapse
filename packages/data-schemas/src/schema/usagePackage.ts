import { Schema } from 'mongoose';
import { USAGE_PACKAGE_SCOPES } from '~/types/usagePackage';
import type { IUsagePackage } from '~/types';

const usagePackageSchema: Schema<IUsagePackage> = new Schema<IUsagePackage>(
  {
    key: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    scopes: {
      type: [String],
      enum: [...USAGE_PACKAGE_SCOPES],
      default: ['member'],
    },
    price: { type: Number, required: true, min: 0 },
    monthlyCredit: { type: Number, required: true, min: 0 },
    weeklyPercent: { type: Number, default: null, min: 1, max: 100 },
    unlimited: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

usagePackageSchema.index({ key: 1 }, { unique: true });

export default usagePackageSchema;
