import { Schema } from 'mongoose';
import type { IBdrenAllowance, IBdrenEvent, IMemberMove, IBdrenUploadTicket } from '~/types';

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

export const memberMoveSchema: Schema<IMemberMove> = new Schema<IMemberMove>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: ['running', 'done', 'refused', 'redirected', 'failed'],
      required: true,
    },
    mode: { type: String, enum: ['transaction', 'sequential'], default: null },
    leaseId: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    plan: { type: Schema.Types.Mixed, default: null },
    completed: { type: [String], default: [] },
    moved: { type: Schema.Types.Mixed, default: {} },
    conflicts: { type: Schema.Types.Mixed, default: {} },
    seatReserved: { type: Boolean, default: false },
    seatReleased: { type: Boolean, default: false },
    userSwitched: { type: Boolean, default: false },
    wasActive: { type: Boolean, default: false },
    refusal: { type: String, default: null },
    droppedGrants: { type: [String], default: [] },
    attempts: { type: Number, default: 0 },
    strippedDetails: { type: [Schema.Types.Mixed], default: [] },
    seatDrift: { type: Boolean, default: false },
    lateSweepAt: { type: Date, default: null },
    lateSweptAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);
/** One running move per user: the lock two triggers race for. */
memberMoveSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'running' }, name: 'one_running_move' },
);
memberMoveSchema.index({ userId: 1, createdAt: -1 });
memberMoveSchema.index({ status: 1, leaseUntil: 1 });
memberMoveSchema.index({ lateSweepAt: 1, lateSweptAt: 1 });
