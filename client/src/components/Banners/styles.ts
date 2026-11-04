import { RefreshCw, TriangleAlert, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import type { TBanner, TBannerCategory } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { NewIcon } from './icons';

export type BannerIcon = ComponentType<{ className?: string }>;

export interface CategoryStyle {
  label: TranslationKeys;
  /** Drawn beside the label; omitted for outages, which show a live dot instead. */
  Icon?: BannerIcon;
  /** Large faded copy in the card header. */
  Watermark: BannerIcon;
  /** Which end of the schedule the bar and card show as a time. */
  window?: 'until' | 'since';
}

const CATEGORY_STYLES: Record<TBannerCategory, CategoryStyle> = {
  feature: { label: 'com_ui_banner_feature', Icon: NewIcon, Watermark: NewIcon },
  update: { label: 'com_ui_banner_update', Icon: RefreshCw, Watermark: RefreshCw },
  maintenance: {
    label: 'com_ui_banner_maintenance',
    Icon: Wrench,
    Watermark: Wrench,
    window: 'until',
  },
  outage: { label: 'com_ui_banner_outage', Watermark: TriangleAlert, window: 'since' },
};

export const getCategoryStyle = (category: TBannerCategory): CategoryStyle =>
  CATEGORY_STYLES[category] ?? CATEGORY_STYLES.update;

/** Props shared by the bar and card presentations. */
export interface BannerViewProps {
  banner: TBanner;
  /** Already sanitized HTML. */
  message: string;
  onDismiss: () => void;
}
