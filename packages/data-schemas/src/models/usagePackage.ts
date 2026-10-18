import { Model } from 'mongoose';
import usagePackageSchema from '~/schema/usagePackage';
import usageAccountSchema from '~/schema/usageAccount';
import usagePricingSchema from '~/schema/usagePricing';
import type { IUsageAccount, IUsagePackage, IUsagePricing } from '~/types';

export function createUsagePackageModel(mongoose: typeof import('mongoose')): Model<IUsagePackage> {
  return (
    mongoose.models.UsagePackage ||
    mongoose.model<IUsagePackage>('UsagePackage', usagePackageSchema)
  );
}

export function createUsagePricingModel(mongoose: typeof import('mongoose')): Model<IUsagePricing> {
  return (
    mongoose.models.UsagePricing ||
    mongoose.model<IUsagePricing>('UsagePricing', usagePricingSchema)
  );
}

export function createUsageAccountModel(mongoose: typeof import('mongoose')): Model<IUsageAccount> {
  return (
    mongoose.models.UsageAccount ||
    mongoose.model<IUsageAccount>('UsageAccount', usageAccountSchema)
  );
}
