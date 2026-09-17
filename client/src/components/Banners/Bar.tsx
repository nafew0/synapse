import { forwardRef } from 'react';
import { XIcon } from 'lucide-react';
import { Button, cn } from '@librechat/client';
import type { BannerViewProps } from './styles';
import { getCategoryStyle } from './styles';
import { useLocalize } from '~/hooks';
import BannerLink from './Link';

/**
 * Slim bar across the top of the page; its height is reported so the layout can shrink.
 * The content is centred on the page: an invisible spacer mirrors the close button's width.
 */
const Bar = forwardRef<HTMLDivElement, BannerViewProps>(({ banner, message, onDismiss }, ref) => {
  const localize = useLocalize();
  const style = getCategoryStyle(banner.category);
  const canDismiss = banner.display !== 'always';

  return (
    <div
      ref={ref}
      role="region"
      aria-label={localize('com_ui_banner_label')}
      className={cn(
        'sticky top-0 z-20 flex min-h-11 items-center gap-2 py-2 text-sm text-text-primary md:relative',
        canDismiss ? 'px-2' : 'px-4',
        style.bar,
      )}
    >
      {canDismiss && <span aria-hidden="true" className="size-8 shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase leading-4 tracking-wide',
            style.chip,
          )}
        >
          {localize(style.label)}
        </span>
        {banner.title && <strong className="font-semibold">{banner.title}</strong>}
        <span
          className="text-text-secondary [&_a]:text-link [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: message }}
        />
        {banner.linkUrl && (
          <BannerLink
            url={banner.linkUrl}
            className="lc-banner-link whitespace-nowrap font-medium underline underline-offset-4"
          >
            {`${banner.linkLabel || banner.linkUrl} →`}
          </BannerLink>
        )}
      </div>
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
  );
});

Bar.displayName = 'BannerBar';

export default Bar;
