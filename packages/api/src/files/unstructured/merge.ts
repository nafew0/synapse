import type { UnstructuredElement } from './types';

/** The model sometimes writes Khmer's ៖ for Bangla's ঃ; they look alike on a scan. */
const MISREAD_VISARGA = /\u17d6/g;

/** Running heads and page numbers are kept: an office document's memo line can sit in one. */
function elementToMarkdown({ type, text, metadata }: UnstructuredElement): string {
  const content = (text ?? '').trim();
  if (type === 'Table' && metadata?.text_as_html) {
    return metadata.text_as_html;
  }
  if (!content || type === 'PageBreak') {
    return '';
  }
  if (type === 'Title') {
    const depth = Math.min((metadata?.category_depth ?? 0) + 1, 6);
    return `${'#'.repeat(depth)} ${content}`;
  }
  return type === 'ListItem' ? `- ${content}` : content;
}

export function elementsToMarkdown(elements: UnstructuredElement[]): string {
  const blocks: string[] = [];
  let page: number | null | undefined;
  for (const element of elements) {
    const number = element.metadata?.page_number;
    if (number != null && number !== page) {
      blocks.push(`<!-- page ${number} -->`);
      page = number;
    }
    const block = elementToMarkdown(element);
    if (block) {
      blocks.push(block);
    }
  }
  return blocks.join('\n\n');
}

/**
 * The whole document in page order: OCR's elements on the pages it read, the parser's text on the
 * rest. OCR numbered its pages within the subset, so they are mapped back to the original numbers.
 * Crops are dropped: they are large, and the sandbox cuts its own from the page.
 */
export function mergePages({
  ocrElements,
  ocrPages,
  texts,
}: {
  ocrElements: UnstructuredElement[];
  /** Original page number of each page sent, in the order sent. */
  ocrPages: number[];
  /** Parser text per original page; empty for an image, which has no parser pages. */
  texts: string[];
}): UnstructuredElement[] {
  const byPage = new Map<number, UnstructuredElement[]>();
  for (const element of ocrElements) {
    const sent = element.metadata?.page_number ?? 1;
    const page = ocrPages[sent - 1] ?? sent;
    const { image_base64: _dropped, ...metadata } = element.metadata ?? {};
    const list = byPage.get(page) ?? [];
    const text = element.text?.replace(MISREAD_VISARGA, 'ঃ');
    list.push({ ...element, text, metadata: { ...metadata, page_number: page } });
    byPage.set(page, list);
  }
  const read = new Set(ocrPages);
  const pageCount = Math.max(texts.length, ...ocrPages, 0);
  const merged: UnstructuredElement[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const text = texts[page - 1]?.trim();
    if (read.has(page)) {
      merged.push(...(byPage.get(page) ?? []));
    } else if (text) {
      merged.push({
        type: 'NarrativeText',
        text,
        metadata: { page_number: page, source: 'parser' },
      });
    }
  }
  return merged;
}
