import type { Model } from 'mongoose';
import type * as t from '~/types/modelPrice';
import {
  modelPriceSchema,
  modelPriceVersionSchema,
  modelPriceChangeSchema,
  modelPriceSyncSchema,
} from '~/schema/modelPrice';

export const createModelPriceModel = (mongoose: typeof import('mongoose')): Model<t.IModelPrice> =>
  mongoose.models.ModelPrice || mongoose.model<t.IModelPrice>('ModelPrice', modelPriceSchema);

export const createModelPriceVersionModel = (
  mongoose: typeof import('mongoose'),
): Model<t.IModelPriceVersion> =>
  mongoose.models.ModelPriceVersion ||
  mongoose.model<t.IModelPriceVersion>('ModelPriceVersion', modelPriceVersionSchema);

export const createModelPriceChangeModel = (
  mongoose: typeof import('mongoose'),
): Model<t.IModelPriceChange> =>
  mongoose.models.ModelPriceChange ||
  mongoose.model<t.IModelPriceChange>('ModelPriceChange', modelPriceChangeSchema);

export const createModelPriceSyncModel = (
  mongoose: typeof import('mongoose'),
): Model<t.IModelPriceSync> =>
  mongoose.models.ModelPriceSync ||
  mongoose.model<t.IModelPriceSync>('ModelPriceSync', modelPriceSyncSchema);
