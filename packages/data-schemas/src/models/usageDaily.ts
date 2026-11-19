import type { Model } from 'mongoose';
import type { IUsageDaily } from '~/types';
import usageDailySchema from '~/schema/usageDaily';

export function createUsageDailyModel(mongoose: typeof import('mongoose')): Model<IUsageDaily> {
  return mongoose.models.UsageDaily || mongoose.model<IUsageDaily>('UsageDaily', usageDailySchema);
}
