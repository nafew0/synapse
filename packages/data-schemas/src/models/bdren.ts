import type { Model } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent, IBdrenUploadTicket } from '~/types';
import { bdrenAllowanceSchema, bdrenEventSchema, bdrenUploadTicketSchema } from '~/schema/bdren';

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

export function createBdrenUploadTicketModel(
  mongoose: typeof import('mongoose'),
): Model<IBdrenUploadTicket> {
  return (
    mongoose.models.BdrenUploadTicket ||
    mongoose.model<IBdrenUploadTicket>('BdrenUploadTicket', bdrenUploadTicketSchema)
  );
}
