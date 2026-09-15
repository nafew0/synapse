import type { Types, Document } from 'mongoose';
import type {
  TBannerApp,
  TBannerType,
  TBannerDisplay,
  TBannerCategory,
} from 'librechat-data-provider';

export interface BannerFields {
  bannerId: string;
  /** Missing on banners saved before admin-panel banners existed; those belong to the chat app. */
  app?: TBannerApp;
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

/** Banner as served to clients: `app`, `category` and `display` are always resolved. */
export type ActiveBanner = Omit<BannerFields, 'app' | 'category' | 'display'> & {
  app: TBannerApp;
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
