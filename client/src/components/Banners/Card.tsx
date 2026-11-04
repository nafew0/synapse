import { XIcon } from 'lucide-react';
import { Button } from '@librechat/client';
import type { BannerViewProps } from './styles';
import { LinkLabel, Marker, When, useSchedule } from './parts';
import { getCategoryStyle } from './styles';
import { useLocalize } from '~/hooks';
import BannerLink from './Link';

/**
 * Floating card in the top-right corner; it overlays the page instead of pushing it down.
 * Shaped like a ticket: a coloured header, the notice, then a tear-off stub with the time and actions.
 */
export default function Card({ banner, message, onDismiss }: BannerViewProps) {
  const localize = useLocalize();
  const style = getCategoryStyle(banner.category);
  const { window, day } = useSchedule(banner, style);
  const canDismiss = banner.display !== 'always';
  const hasStub = canDismiss || Boolean(banner.linkUrl) || Boolean(window);
  const { Watermark } = style;

  return (
    <section
      aria-label={localize('com_ui_banner_label')}
      data-category={banner.category}
      className="lc-banner lc-banner-card fixed inset-x-3 top-16 z-40 text-text-primary md:inset-x-auto md:right-6 md:w-96"
    >
      <div className="lc-banner-sheet overflow-hidden rounded-t-2xl">
        <div className="lc-banner-band relative flex items-center gap-2.5 overflow-hidden py-3.5 pl-[18px] pr-3">
          <Marker style={style} />
          <span className="text-xs font-bold uppercase tracking-wider">
            {localize(style.label)}
          </span>
          {day && <span className="text-[12.5px] tabular-nums opacity-80">· {day}</span>}
          <Watermark className="lc-banner-watermark pointer-events-none absolute -right-3.5 -top-5 size-[120px]" />
          {canDismiss && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={localize('com_ui_banner_dismiss')}
              className="lc-banner-close relative ml-auto"
              onClick={onDismiss}
            >
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="px-5 pb-5 pt-[18px]">
          {banner.title && (
            <h2 className="mb-2 text-balance text-xl font-semibold leading-tight tracking-tight">
              {banner.title}
            </h2>
          )}
          <p
            className="text-sm leading-relaxed text-text-secondary [&_a]:underline [&_a]:underline-offset-2"
            dangerouslySetInnerHTML={{ __html: message }}
          />
        </div>
      </div>
      {hasStub ? (
        <>
          <div className="lc-banner-perf h-[18px]" aria-hidden="true" />
          <div className="lc-banner-sheet flex flex-wrap items-center gap-2.5 rounded-b-2xl pb-4 pl-5 pr-4 pt-3">
            <span className="mr-auto">{window && <When {...window} />}</span>
            {canDismiss && (
              <Button variant="outline" size="sm" onClick={onDismiss}>
                {localize('com_ui_banner_got_it')}
              </Button>
            )}
            {banner.linkUrl && (
              <BannerLink
                url={banner.linkUrl}
                onClick={canDismiss ? onDismiss : undefined}
                className="lc-banner-go inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold"
              >
                <LinkLabel url={banner.linkUrl} label={banner.linkLabel || banner.linkUrl} />
              </BannerLink>
            )}
          </div>
        </>
      ) : (
        <div className="lc-banner-sheet h-1.5 rounded-b-2xl" />
      )}
    </section>
  );
}
