import { Model } from 'mongoose';
import type { IBannerView } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import bannerViewSchema from '~/schema/bannerView';

export function createBannerViewModel(mongoose: typeof import('mongoose')): Model<IBannerView> {
  applyTenantIsolation(bannerViewSchema);
  return mongoose.models.BannerView || mongoose.model<IBannerView>('BannerView', bannerViewSchema);
}
