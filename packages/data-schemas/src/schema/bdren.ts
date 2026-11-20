import { Schema } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent } from '~/types';

export const bdrenAllowanceSchema: Schema<IBdrenAllowance> = new Schema<IBdrenAllowance>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    tenantId: { type: String, required: true, index: true },
    issuer: { type: String, required: true },
    subject: { type: String, required: true },
    etag: { type: String, required: true },
    allowance: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true },
    verifiedAt: { type: Date, required: true },
    invalidatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
bdrenAllowanceSchema.index({ issuer: 1, subject: 1 });

export const bdrenEventSchema: Schema<IBdrenEvent> = new Schema<IBdrenEvent>({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  receivedAt: { type: Date, required: true, expires: 60 * 60 * 24 * 7 },
});
