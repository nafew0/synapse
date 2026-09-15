import type { TBanner, TBannerCategory } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export interface CategoryStyle {
  label: TranslationKeys;
  /** Bar background. */
  bar: string;
  /** Pill on the bar. */
  chip: string;
  /** Gradient header on the card. */
  header: string;
  /** Category label above the card title. */
  eyebrow: string;
}

const CATEGORY_STYLES: Record<TBannerCategory, CategoryStyle> = {
  feature: {
    label: 'com_ui_banner_feature',
    bar: 'lc-banner-feature',
    chip: 'bg-accent-primary text-text-on-status',
    header: 'lc-banner-card-feature',
    eyebrow: 'lc-banner-eyebrow-feature',
  },
  update: {
    label: 'com_ui_banner_update',
    bar: 'lc-banner-update',
    chip: 'lc-banner-chip-update',
    header: 'lc-banner-card-update',
    eyebrow: 'lc-banner-link',
  },
  maintenance: {
    label: 'com_ui_banner_maintenance',
    bar: 'bg-status-warning-subtle',
    chip: 'bg-status-warning-strong text-text-on-status',
    header: 'lc-banner-card-maintenance',
    eyebrow: 'text-status-warning',
  },
  outage: {
    label: 'com_ui_banner_outage',
    bar: 'bg-status-error-subtle',
    chip: 'bg-status-error-strong text-text-on-status',
    header: 'lc-banner-card-outage',
    eyebrow: 'text-status-error',
  },
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
