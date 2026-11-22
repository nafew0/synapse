import type { Model } from 'mongoose';
import type { IUsageJob } from '~/types';
import usageJobSchema from '~/schema/usageJob';

export function createUsageJobModel(mongoose: typeof import('mongoose')): Model<IUsageJob> {
  return mongoose.models.UsageJob || mongoose.model<IUsageJob>('UsageJob', usageJobSchema);
}
