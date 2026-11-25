import { Schema } from 'mongoose';
import type { IInstitution } from '~/types';
import { InstitutionStatuses } from '~/common';

const institutionSchema: Schema<IInstitution> = new Schema<IInstitution>(
  {
    tenantId: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
    },
    /** The bdren.ai organization this institution is. Members' seats and limits come from there. */
    bdrenOrganizationId: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(InstitutionStatuses),
      default: InstitutionStatuses.ACTIVE,
      index: true,
    },
    authDomains: {
      type: [String],
      default: [],
    },
    timezone: {
      type: String,
      default: 'Asia/Dhaka',
      trim: true,
    },
    /** Superadmin switch: may this institution's scans be sent to the OCR service. */
    ocrAccess: {
      type: Boolean,
      default: false,
    },
    usagePolicyVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Usage package keys: the institution's own pooled allowance and the default for its members. */
    usagePackage: {
      type: {
        packageKey: { type: String, trim: true, default: null },
        memberPackageKey: { type: String, trim: true, default: null },
        assignedAt: { type: Date },
        assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      },
      default: null,
    },
    /** The browser extension: off until switched on for the institution, with sites it may never open. */
    browserControl: {
      type: {
        extensionEnabled: { type: Boolean, default: false },
        blockedDomains: { type: [String], default: [] },
      },
      default: { extensionEnabled: false, blockedDomains: [] },
    },
    limits: {
      type: {
        maxActiveMembers: {
          type: Number,
          default: null,
          min: 1,
        },
      },
      default: {},
    },
    stats: {
      type: {
        activeMembers: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
      default: {},
    },
    /**
     * Seat changes member moves already applied (`reserve:<moveId>`, `release:<moveId>`), so a
     * retried move never counts a seat twice. Bounded to the most recent entries.
     */
    seatOps: {
      type: [String],
      default: undefined,
      select: false,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    suspendedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    chatAccess: {
      type: {
        ended: { type: Boolean, default: false },
        message: { type: String, trim: true, maxlength: 500, default: '' },
        contact: { type: String, trim: true, maxlength: 200, default: '' },
        changedAt: { type: Date, default: null },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        _id: false,
      },
      default: null,
    },
  },
  { timestamps: true },
);

institutionSchema.index({ tenantId: 1 }, { unique: true });
institutionSchema.index(
  { bdrenOrganizationId: 1 },
  { unique: true, partialFilterExpression: { bdrenOrganizationId: { $type: 'string' } } },
);
institutionSchema.index({ slug: 1 }, { unique: true, sparse: true });

export default institutionSchema;
