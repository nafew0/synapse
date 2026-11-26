import type { Document, Types } from 'mongoose';
import type { InstitutionUsagePackage } from './usagePackage';
import type { InstitutionStatus } from '~/common';

export interface IInstitution extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  name: string;
  slug?: string;
  bdrenOrganizationId?: string;
  status: InstitutionStatus;
  authDomains?: string[];
  timezone?: string;
  ocrAccess?: boolean;
  usagePolicyVersion?: number;
  usagePackage?: InstitutionUsagePackage | null;
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
  /** Seat changes member moves already applied; see the schema. */
  seatOps?: string[];
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
