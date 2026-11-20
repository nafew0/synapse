import { Schema } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent, IBdrenUploadTicket } from '~/types';

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
    previousWindows: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
bdrenAllowanceSchema.index({ issuer: 1, subject: 1 });

export const bdrenEventSchema: Schema<IBdrenEvent> = new Schema<IBdrenEvent>({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  receivedAt: { type: Date, required: true, expires: 60 * 60 * 24 * 7 },
});

export const bdrenUploadTicketSchema: Schema<IBdrenUploadTicket> = new Schema<IBdrenUploadTicket>(
  {
    ticketId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true, immutable: true },
    organizationId: { type: String, required: true },
    actorUserId: { type: String, required: true },
    actorSubject: { type: String, required: true },
    filename: { type: String, required: true },
    extension: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    title: { type: String },
    docType: { type: String },
    documentId: { type: String },
    /** Kept for an hour past expiry so a late use is told "expired", then removed. */
    expiresAt: { type: Date, required: true, expires: 60 * 60 },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
