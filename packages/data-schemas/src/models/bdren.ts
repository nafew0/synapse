import type { Model } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent, IMemberMove, IBdrenUploadTicket } from '~/types';
import {
  memberMoveSchema,
  bdrenEventSchema,
  bdrenAllowanceSchema,
  bdrenUploadTicketSchema,
} from '~/schema/bdren';

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

export function createMemberMoveModel(mongoose: typeof import('mongoose')): Model<IMemberMove> {
  return mongoose.models.MemberMove || mongoose.model<IMemberMove>('MemberMove', memberMoveSchema);
}
