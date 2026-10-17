import type { Document, Types } from 'mongoose';

export type UsageReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

/** What this reservation consumes. Images are billed per image by the provider,
 *  so counting their tokens would misprice them by orders of magnitude. */
export type UsageReservationUnit = 'tokens' | 'images';

/** One bucket this reservation holds capacity in. A request now spans several
 *  windows, so the bucket a settlement must return capacity to can no longer be
 *  derived from a single `periodStart` on the reservation. */
export interface IUsageReservationScope {
  scopeType: string;
  scopeKey: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface IUsageReservation extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  reservationKey: string;
  userId: Types.ObjectId;
  providerKey: string;
  modelKey: string;
  policyVersion: number;
  periodStart: Date;
  periodEnd: Date;
  estimatedInputTokens: number;
  outputTokenCap: number;
  reservedTokens: number;
  actualTokens?: number;
  /**
   * Quota weight applied when this reservation was created (e.g. 2 for Claude
   * used directly). Stored, not recomputed at settlement, so a mid-flight
   * policy change cannot settle against a different weight than it reserved.
   * Billing-only: never applied to `Transaction`.
   */
  weight: number;
  unit: UsageReservationUnit;
  /** Images charged to the image meter when this token reservation settled. */
  imagesSettled: number;
  /** Empty for reservations created before multi-window support; readers fall
   *  back to the legacy institution/member/model triple on `periodStart`. */
  scopes: IUsageReservationScope[];
  status: UsageReservationStatus;
  expiresAt: Date;
  settledAt?: Date | null;
  releasedAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}
