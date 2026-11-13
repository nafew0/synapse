import type { Document, Types } from 'mongoose';
import type { InstitutionStatus } from '~/common';

export interface IInstitution extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  name: string;
  slug?: string;
  status: InstitutionStatus;
  authDomains?: string[];
  timezone?: string;
  ocrAccess?: boolean;
  usagePolicyVersion?: number;
  packageAssignment?: {
    packageId: string;
    packageSnapshot: {
      name: string;
      description?: string;
      price: number;
      currency: string;
      monthlyTokenLimit: number;
    };
    monthlyTokenLimit: number;
    assignedAt: Date;
    assignedBy?: Types.ObjectId | string;
  } | null;
  browserControl?: {
    extensionEnabled?: boolean;
    blockedDomains?: string[];
  };
  limits?: {
    maxActiveMembers?: number | null;
  };
  stats?: {
    activeMembers?: number;
  };
  createdBy?: Types.ObjectId | string;
  /** Set by a platform superadmin to stop new chats, e.g. when a free trial is over. */
  chatAccess?: {
    ended: boolean;
    message?: string;
    /** An email address or https link members can use to ask for more usage. */
    contact?: string;
    changedAt?: Date | null;
    changedBy?: Types.ObjectId | string | null;
  } | null;
  suspendedAt?: Date | null;
  suspendedBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
