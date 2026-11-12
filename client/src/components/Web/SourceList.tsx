import { FaviconImage, getCleanDomain } from './SourceHovercard';
import cn from '~/utils/cn';

export interface SourceLink {
  link: string;
  title?: string;
}

const MAX_VISIBLE_FAVICONS = 3;

function getUniqueDomainSources(sources: SourceLink[], max: number): SourceLink[] {
  const seen = new Set<string>();
  const result: SourceLink[] = [];
  for (const source of sources) {
    const domain = getCleanDomain(source.link);
    if (seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(source);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

export function SourceFaviconStack({ sources }: { sources: SourceLink[] }) {
  const visible = getUniqueDomainSources(sources, MAX_VISIBLE_FAVICONS);
  return (
    <div className="flex items-center" aria-hidden="true">
      {visible.map((source, i) => (
        <div
          key={source.link}
          className={cn(
            'relative flex items-center justify-center rounded-full border border-border-medium bg-surface-secondary',
            'h-[22px] w-[22px]',
            i > 0 && '-ml-2.5',
          )}
          style={{ zIndex: MAX_VISIBLE_FAVICONS - i }}
        >
          <FaviconImage domain={getCleanDomain(source.link)} className="size-3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Bordered list of linked sources: favicon, title and domain per row. */
export function SourceList({ sources }: { sources: SourceLink[] }) {
  return (
    <div className="my-2 max-h-[280px] overflow-y-auto rounded-lg border border-border-light">
      {sources.map((source, i) => {
        const domain = getCleanDomain(source.link);
        return (
          <a
            key={source.link}
            href={source.link}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-hover',
              i > 0 && 'border-t border-border-light',
            )}
          >
            <FaviconImage domain={domain} className="size-4 shrink-0 rounded-sm" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
              {source.title || domain}
            </span>
            <span className="shrink-0 text-[11px] text-text-secondary">{domain}</span>
          </a>
        );
      })}
    </div>
  );
}
