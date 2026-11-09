import { useMemo, useState } from 'react';
import { Globe, ChevronDown } from 'lucide-react';
import type { PartMetadata } from 'librechat-data-provider';
import { FaviconImage, getCleanDomain } from '~/components/Web/SourceHovercard';
import { SourceList, SourceFaviconStack } from '~/components/Web/SourceList';
import { useLocalize, useExpandCollapse, useLazyCollapseBody } from '~/hooks';
import { parsePageSource, parseSearchSources } from './sources';
import useToolCallState from './useToolCallState';
import { useDenseSteps } from './StepRow';
import { useToolCallIntent } from './intent';
import { WEB_SEARCH_TOOL_NAMES } from '~/utils/toolLabels';
import cn from '~/utils/cn';

const rowBase = 'tool-status-text flex min-w-0 items-center gap-2.5 text-text-secondary';

function useRowClass(): string {
  return cn(rowBase, useDenseSteps() ? 'my-0.5' : 'my-1');
}

function GlobeIcon({ animate = false }: { animate?: boolean }) {
  return (
    <Globe
      className={cn('size-4 shrink-0 text-text-secondary', animate && 'animate-pulse')}
      aria-hidden="true"
    />
  );
}

function SearchResults({
  label,
  output,
  onExpand,
}: {
  label: string;
  output: string;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const rowClass = useRowClass();
  const dense = useDenseSteps();
  const sources = useMemo(() => parseSearchSources(output), [output]);
  const [open, setOpen] = useState(false);
  const { style, ref } = useExpandCollapse(open);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(open);

  if (sources.length === 0) {
    return (
      <div className={rowClass}>
        <GlobeIcon />
        <span className="min-w-0 truncate font-medium">{label}</span>
      </div>
    );
  }

  const toggle = () => {
    mountBody();
    setOpen((prev) => {
      if (!prev) {
        onExpand?.();
      }
      return !prev;
    });
  };

  return (
    <div className={dense ? 'my-0.5' : 'mb-2'}>
      <button
        type="button"
        className={cn(
          'tool-status-text group flex items-center gap-2 rounded-full py-1 text-text-secondary transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
        )}
        onClick={toggle}
        aria-expanded={open}
        aria-label={`${label} - ${localize(
          sources.length === 1 ? 'com_ui_web_search_source' : 'com_ui_web_search_sources',
          { count: sources.length },
        )}`}
      >
        <SourceFaviconStack sources={sources} />
        <span className="min-w-0 truncate font-medium">{label}</span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-text-secondary transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      <div style={style} onTransitionEnd={handleTransitionEnd}>
        <div className="overflow-hidden" ref={ref}>
          {shouldRenderBody && <SourceList sources={sources} />}
        </div>
      </div>
    </div>
  );
}

function PageRead({ output, args }: { output: string; args?: string | Record<string, unknown> }) {
  const localize = useLocalize();
  const rowClass = useRowClass();
  const page = useMemo(() => parsePageSource(output, args), [output, args]);

  if (!page) {
    return (
      <div className={rowClass}>
        <GlobeIcon />
        <span className="min-w-0 truncate font-medium">{localize('com_ui_web_page_read')}</span>
      </div>
    );
  }

  const domain = getCleanDomain(page.link);
  return (
    <a
      href={page.link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(rowClass, 'w-fit max-w-full hover:text-text-primary')}
    >
      <FaviconImage domain={domain} className="size-4 shrink-0 rounded-sm" />
      <span className="min-w-0 truncate font-medium">
        {localize('com_ui_web_page_read_named', { 0: page.title || domain })}
      </span>
      {page.title && <span className="shrink-0 text-[11px]">{domain}</span>}
    </a>
  );
}

/**
 * A web search or page read, shown the way a reader expects: a short label and
 * the sources used. The query, settings and page text stay out of the chat.
 */
export default function WebToolCall({
  name,
  args,
  output = '',
  initialProgress = 0.1,
  isSubmitting,
  runStepStatus,
  onExpand,
}: {
  name: string;
  args?: string | Record<string, unknown>;
  output?: string;
  initialProgress?: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const rowClass = useRowClass();
  const intent = useToolCallIntent(args, name);
  const isSearch = WEB_SEARCH_TOOL_NAMES.has(name);
  const { phase } = useToolCallState({
    initialProgress,
    isSubmitting,
    output,
    hasInput: false,
    runStepStatus,
  });

  if (phase === 'cancelled') {
    return null;
  }

  if (phase === 'running') {
    const runningText = isSearch
      ? localize('com_ui_web_searching')
      : localize('com_ui_web_page_reading');
    return (
      <div className={rowClass}>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {runningText}
        </span>
        <GlobeIcon animate />
        <span className="shimmer min-w-0 truncate font-medium">{intent ?? runningText}</span>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className={rowClass}>
        <GlobeIcon />
        <span className="min-w-0 truncate font-medium">
          {localize(isSearch ? 'com_ui_web_search_failed' : 'com_ui_web_page_read_failed')}
        </span>
      </div>
    );
  }

  if (isSearch) {
    return (
      <SearchResults
        label={intent ?? localize('com_ui_web_searched')}
        output={output}
        onExpand={onExpand}
      />
    );
  }
  return <PageRead output={output} args={args} />;
}
