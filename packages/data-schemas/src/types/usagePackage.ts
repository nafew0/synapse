import type { Document, Types } from 'mongoose';

/** Who a package can be assigned to. */
export const USAGE_PACKAGE_SCOPES = ['member', 'institution'] as const;
export type UsagePackageScope = (typeof USAGE_PACKAGE_SCOPES)[number];

/** The editable fields of a package, in taka. Dollar credits are derived from these and the pricing settings. */
export interface UsagePackageFields {
  key: string;
  name: string;
  description?: string;
  scopes: UsagePackageScope[];
  /** What the customer pays per month, in BDT. */
  price: number;
  /** API usage the package allows per month, in BDT at cost. */
  monthlyCredit: number;
  /** Weekly cap as a percentage of `monthlyCredit`; `null` uses the pricing default. */
  weeklyPercent: number | null;
  /** Shown to users as "Unlimited"; `monthlyCredit` is still the enforced ceiling. */
  unlimited: boolean;
  active: boolean;
  sortOrder: number;
}

export interface IUsagePackage extends UsagePackageFields, Document {
  _id: Types.ObjectId;
  createdBy?: Types.ObjectId | string | null;
  updatedBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Conversion settings shared by every package. */
export interface UsagePricingFields {
  /** Taka per US dollar. */
  bdtPerUsd: number;
  /** Fee the provider adds when credits are bought, as a percentage. */
  providerFeePercent: number;
  /** Weekly cap for packages that do not set their own, as a percentage of the monthly credit. */
  defaultWeeklyPercent: number;
}

export interface IUsagePricing extends UsagePricingFields, Document {
  _id: Types.ObjectId;
  key: string;
  updatedBy?: Types.ObjectId | string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
