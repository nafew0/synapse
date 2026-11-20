import type { Model } from 'mongoose';
import type { ICostSettings } from '~/types';
import costSettingsSchema from '~/schema/costSettings';

export function createCostSettingsModel(mongoose: typeof import('mongoose')): Model<ICostSettings> {
  return (
    mongoose.models.CostSettings ||
    mongoose.model<ICostSettings>('CostSettings', costSettingsSchema)
  );
}
