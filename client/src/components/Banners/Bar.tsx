import { forwardRef } from 'react';
import { XIcon } from 'lucide-react';
import { Button } from '@librechat/client';
import type { BannerViewProps } from './styles';
import { LinkLabel, Marker, When, useSchedule } from './parts';
import { getCategoryStyle } from './styles';
import { useLocalize } from '~/hooks';
import BannerLink from './Link';

/**
 * Slim bar across the top of the page; its height is reported so the layout can shrink.
 * A solid category block leads, then the words, then the time, link and close button.
 * On phones the words drop to their own row under the block.
 */
const Bar = forwardRef<HTMLDivElement, BannerViewProps>(({ banner, message, onDismiss }, ref) => {
  const localize = useLocalize();
  const style = getCategoryStyle(banner.category);
  const { window } = useSchedule(banner, style);
  const canDismiss = banner.display !== 'always';

  return (
    <div
      ref={ref}
      role="region"
      aria-label={localize('com_ui_banner_label')}
      data-category={banner.category}
      className="lc-banner lc-banner-bar sticky top-0 z-20 flex min-h-12 flex-wrap items-stretch text-sm md:relative md:flex-nowrap"
    >
      <span className="lc-banner-block flex shrink-0 items-center gap-2 py-2 pl-4 pr-7 text-xs font-bold uppercase tracking-wider">
        <Marker style={style} />
        {localize(style.label)}
      </span>
      <div className="lc-banner-words order-3 flex min-w-0 basis-full flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3.5 pb-3 pt-2 leading-snug md:order-none md:flex-1 md:basis-auto md:pb-2">
        {banner.title && (
          <strong className="font-semibold text-text-primary">{banner.title}</strong>
        )}
        <span
          className="text-text-secondary [&_a]:underline [&_a]:underline-offset-2"
          dangerouslySetInnerHTML={{ __html: message }}
        />
        {window && <When {...window} className="inline-flex md:hidden" />}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 pr-2">
        {window && <When {...window} className="hidden md:inline-flex" />}
        {banner.linkUrl && (
          <BannerLink
            url={banner.linkUrl}
            className="lc-banner-cta inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold"
          >
            <LinkLabel url={banner.linkUrl} label={banner.linkLabel || banner.linkUrl} />
          </BannerLink>
        )}
        {canDismiss && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={localize('com_ui_banner_dismiss')}
            className="size-8 shrink-0"
            onClick={onDismiss}
          >
            <XIcon className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
});

Bar.displayName = 'BannerBar';

export default Bar;
