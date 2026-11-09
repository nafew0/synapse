import { Clock, ArrowRight, ExternalLink } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { cn } from '@librechat/client';
import type { TBanner } from 'librechat-data-provider';
import type { CategoryStyle } from './styles';
import { getSchedule } from './schedule';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** The category's icon, or a blinking dot while an outage is live. */
export function Marker({ style }: { style: CategoryStyle }) {
  const { Icon } = style;
  if (!Icon) {
    return <span aria-hidden="true" className="lc-banner-live size-2 shrink-0 rounded-full" />;
  }
  return (
    <span aria-hidden="true" className="lc-banner-icon inline-flex shrink-0">
      <Icon className="size-4" />
    </span>
  );
}

export function useSchedule(banner: TBanner, style: CategoryStyle) {
  const lang = useRecoilValue(store.lang);
  return getSchedule(banner, style, lang);
}

interface WhenProps {
  kind: 'until' | 'since';
  moment: string;
  className?: string;
}

export function When({ kind, moment, className }: WhenProps) {
  const localize = useLocalize();
  const key = kind === 'until' ? 'com_ui_banner_until' : 'com_ui_banner_since';
  return (
    <span
      className={cn(
        'lc-banner-fg items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold tabular-nums',
        className ?? 'inline-flex',
      )}
    >
      <Clock className="size-4" aria-hidden="true" />
      {localize(key, { 0: moment })}
    </span>
  );
}

/** The link's own label, with an arrow for in-app paths and an external mark otherwise. */
export function LinkLabel({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className?: string;
}) {
  const localize = useLocalize();
  const external = !url.startsWith('/');
  const Icon = external ? ExternalLink : ArrowRight;
  return (
    <>
      {label}
      <Icon className={cn('size-4', className)} aria-hidden="true" />
      {external && <span className="sr-only">{localize('com_ui_banner_new_tab')}</span>}
    </>
  );
}
