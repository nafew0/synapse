import { Schema } from 'mongoose';
import type { IUsageAccount } from '~/types';

const usageAccountSchema: Schema<IUsageAccount> = new Schema<IUsageAccount>(
  {
    tenantId: { type: String, required: true, immutable: true, trim: true },
    name: { type: String, required: true, trim: true },
    timezone: { type: String, trim: true },
    usagePolicyVersion: { type: Number, default: 0, min: 0 },
    usagePackage: {
      type: {
        packageKey: { type: String, trim: true, default: null },
        memberPackageKey: { type: String, trim: true, default: null },
        assignedAt: { type: Date },
        assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      },
      default: null,
    },
  },
  { timestamps: true },
);

usageAccountSchema.index({ tenantId: 1 }, { unique: true });

export default usageAccountSchema;
