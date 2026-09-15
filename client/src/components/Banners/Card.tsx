import { XIcon } from 'lucide-react';
import { Button, buttonVariants, cn } from '@librechat/client';
import type { BannerViewProps } from './styles';
import { getCategoryStyle } from './styles';
import { useLocalize } from '~/hooks';
import BannerLink from './Link';

const NODES: [number, number][] = [
  [20, 70],
  [62, 34],
  [104, 78],
  [148, 28],
  [190, 64],
  [232, 30],
  [270, 82],
  [120, 50],
  [210, 92],
  [320, 46],
];
const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [1, 7],
  [7, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [2, 7],
  [4, 8],
  [8, 6],
  [2, 8],
  [5, 9],
  [6, 9],
];
const ACCENT_NODE = 3;

/** Connected-node motif for the card header — a nod to the Synapse name. */
function Network() {
  return (
    <svg
      viewBox="0 0 340 104"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {EDGES.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          x1={NODES[a][0]}
          y1={NODES[a][1]}
          x2={NODES[b][0]}
          y2={NODES[b][1]}
          className="lc-banner-network-edge"
        />
      ))}
      {NODES.map(([x, y], i) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={i === ACCENT_NODE ? 5 : 3}
          className={i === ACCENT_NODE ? 'lc-banner-network-accent' : 'lc-banner-network-node'}
        />
      ))}
      <circle
        cx={NODES[ACCENT_NODE][0]}
        cy={NODES[ACCENT_NODE][1]}
        r={11}
        className="lc-banner-network-ring"
      />
    </svg>
  );
}

/** Floating card in the top-right corner; it overlays the page instead of pushing it down. */
export default function Card({ banner, message, onDismiss }: BannerViewProps) {
  const localize = useLocalize();
  const style = getCategoryStyle(banner.category);
  const canDismiss = banner.display !== 'always';
  const hasActions = canDismiss || Boolean(banner.linkUrl);

  return (
    <section
      aria-label={localize('com_ui_banner_label')}
      className="fixed inset-x-3 top-16 z-40 overflow-hidden rounded-2xl bg-surface-dialog text-text-primary shadow-2xl ring-1 ring-border-light motion-safe:duration-300 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-4 md:inset-x-auto md:right-6 md:w-[22rem]"
    >
      <div className={cn('lc-banner-card-header relative h-24', style.header)}>
        <Network />
        {canDismiss && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={localize('com_ui_banner_dismiss')}
            className="lc-banner-card-close absolute right-2 top-2"
            onClick={onDismiss}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 p-4">
        <span className={cn('text-xs font-semibold uppercase tracking-wide', style.eyebrow)}>
          {localize(style.label)}
        </span>
        {banner.title && (
          <h2 className="text-base font-semibold leading-snug text-text-primary">{banner.title}</h2>
        )}
        <p
          className="text-sm leading-relaxed text-text-secondary [&_a]:text-link [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: message }}
        />
        {hasActions && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {banner.linkUrl && (
              <BannerLink
                url={banner.linkUrl}
                onClick={canDismiss ? onDismiss : undefined}
                className={buttonVariants({ variant: 'submit', size: 'sm' })}
              >
                {banner.linkLabel || banner.linkUrl}
              </BannerLink>
            )}
            {canDismiss && (
              <Button variant="outline" size="sm" onClick={onDismiss}>
                {localize('com_ui_banner_got_it')}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
