import type { Document, Types } from 'mongoose';

export type UsagePolicyMode = 'shadow' | 'enforce';

/** Windows a policy can enforce. Calendar (not rolling) so a hard wall has a
 *  definite reset instant to show the user. */
export type UsagePolicyPeriod = 'calendar_month' | 'calendar_week';

export interface IUsageModelLimit {
  modelKey: string;
  maxTokens: number | null;
}

export interface IUsagePolicy extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  version: number;
  mode: UsagePolicyMode;
  timezone: string;
  /** Windows enforced by this policy. Both are checked on every request. */
  period: UsagePolicyPeriod[];
  limits: {
    institutionTokens: number | null;
    /** Monthly weighted-token allowance per member. */
    memberTokens: number | null;
    /** Weekly weighted-token allowance per member. Resets in full each week. */
    memberTokensWeekly: number | null;
    /** Monthly image-generation allowance per member, counted in images. */
    memberImages: number | null;
    /** Weekly image-generation allowance per member. */
    memberImagesWeekly: number | null;
    modelTokens: IUsageModelLimit[];
  };
  warningThresholds: number[];
  inputSafetyFactor: number;
  inputSafetyTokens: number;
  effectiveAt: Date;
  reason?: string;
  createdBy?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}
