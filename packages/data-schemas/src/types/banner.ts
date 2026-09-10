import type { Types, Document } from 'mongoose';
import type { TBannerCategory, TBannerDisplay, TBannerType } from 'librechat-data-provider';

export interface BannerFields {
  bannerId: string;
  title?: string;
  message: string;
  category?: TBannerCategory;
  display?: TBannerDisplay;
  linkLabel?: string;
  linkUrl?: string;
  displayFrom: Date;
  displayTo?: Date;
  type: TBannerType;
  isPublic: boolean;
  /** @deprecated Superseded by `display: 'always'`; still read for banners saved before it existed. */
  persistable: boolean;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBanner extends BannerFields, Document {}

/** Banner as served to clients: `category` and `display` are always resolved. */
export type ActiveBanner = Omit<BannerFields, 'category' | 'display'> & {
  category: TBannerCategory;
  display: TBannerDisplay;
};

export interface BannerViewFields {
  user: Types.ObjectId;
  bannerId: string;
  seenAt?: Date;
  dismissedAt?: Date;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBannerView extends BannerViewFields, Document {}
