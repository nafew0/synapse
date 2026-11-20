import type { Model } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent } from '~/types';
import { bdrenAllowanceSchema, bdrenEventSchema } from '~/schema/bdren';

export function createBdrenAllowanceModel(
  mongoose: typeof import('mongoose'),
): Model<IBdrenAllowance> {
  return (
    mongoose.models.BdrenAllowance ||
    mongoose.model<IBdrenAllowance>('BdrenAllowance', bdrenAllowanceSchema)
  );
}

export function createBdrenEventModel(mongoose: typeof import('mongoose')): Model<IBdrenEvent> {
  return mongoose.models.BdrenEvent || mongoose.model<IBdrenEvent>('BdrenEvent', bdrenEventSchema);
}
