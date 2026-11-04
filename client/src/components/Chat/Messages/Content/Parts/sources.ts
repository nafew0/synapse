import type { SourceLink } from '~/components/Web/SourceList';
import parseJsonField from './parseJsonField';

const SEARCH_RESULT = /^\d+\. (.+)\nURL: (\S+)/gm;
const PAGE_TITLE = /^# (.+)$/m;
const PAGE_URL = /^URL: (\S+)/m;
const UNREADABLE_PAGE = /^No readable content at (\S+) \(/;

/** Sources listed in a web search's output (numbered title, then `URL:` line). */
export function parseSearchSources(output: string): SourceLink[] {
  const sources = new Map<string, SourceLink>();
  for (const [, title, link] of output.matchAll(SEARCH_RESULT)) {
    if (!sources.has(link)) {
      sources.set(link, { link, title: title.trim() });
    }
  }
  return Array.from(sources.values());
}

/** The page a read returned (`# title` and `URL:` header), falling back to the requested URL. */
export function parsePageSource(
  output: string,
  args?: string | Record<string, unknown>,
): SourceLink | null {
  const link =
    output.match(PAGE_URL)?.[1] ??
    output.match(UNREADABLE_PAGE)?.[1] ??
    parseJsonField(args, 'url');
  if (!link) {
    return null;
  }
  const title = output.match(PAGE_TITLE)?.[1]?.trim();
  return title ? { link, title } : { link };
}
