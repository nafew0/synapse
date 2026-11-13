import type { PartitionFile, UnstructuredElement } from '~/files/unstructured/types';
import type { KbElement } from './types';
import { subsetPdf } from '~/files/unstructured/pages';
import { cleanCell, cleanText } from './normalize';

const TEXT_TYPES = new Set([
  'NarrativeText',
  'UncategorizedText',
  'ListItem',
  'Address',
  'EmailAddress',
  'FigureCaption',
  'Formula',
  'Form',
]);

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

const decode = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]);

/**
 * Reads Unstructured's `text_as_html` into rows. A cell spanning columns fills the ones it covers
 * with blanks, as Docling tables do, so a row never shifts under the header.
 */
export function parseHtmlTable(html: string): { header: string[]; rows: string[][] } {
  const rows: { cells: string[]; header: boolean }[] = [];
  for (const [, inner] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    let header = false;
    for (const [, tag, attrs, content] of inner.matchAll(/<(t[hd])([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
      header ||= tag.toLowerCase() === 'th';
      const span = Number(/colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1);
      cells.push(cleanCell(decode(content)), ...Array<string>(Math.max(0, span - 1)).fill(''));
    }
    if (cells.some(Boolean)) {
      rows.push({ cells, header });
    }
  }
  const width = Math.max(0, ...rows.map((row) => row.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill('')];
  const headerCount = rows.findIndex((row) => !row.header);
  const split = headerCount === -1 ? 0 : headerCount;
  return {
    header: split > 0 ? pad(rows[split - 1].cells) : [],
    rows: rows.slice(split).map((row) => pad(row.cells)),
  };
}

/**
 * Maps Unstructured elements read from a page subset back onto the original document's pages
 * (`pages[i]` is the original number of subset page i + 1).
 */
export function ocrToElements(elements: UnstructuredElement[], pages: number[]): KbElement[] {
  const result: KbElement[] = [];
  for (const element of elements) {
    const subsetPage = element.metadata?.page_number ?? 1;
    const page = pages[subsetPage - 1] ?? null;
    const html = element.metadata?.text_as_html;
    if (element.type === 'Table' && html) {
      const { header, rows } = parseHtmlTable(html);
      if (rows.length > 0) {
        result.push({ kind: 'table', header, rows, pageStart: page, pageEnd: page });
      }
      continue;
    }
    const text = cleanText(element.text ?? '');
    if (!text) {
      continue;
    }
    if (element.type === 'Title') {
      result.push({ kind: 'heading', text, level: element.metadata?.category_depth ?? 1, page });
    } else if (TEXT_TYPES.has(element.type) || element.type === 'Table') {
      result.push({ kind: 'text', text: element.type === 'ListItem' ? `• ${text}` : text, page });
    }
  }
  return result;
}

export interface KbOcrReader {
  /** Most pages one document may send; the rest stay unreadable. */
  maxPages: number;
  partition(file: PartitionFile): Promise<UnstructuredElement[]>;
}

/** Sends only the given pages of a PDF to OCR and returns their elements on the original pages. */
export async function readPdfPagesWithOcr(
  reader: KbOcrReader,
  buffer: Buffer,
  pages: number[],
  filename: string,
): Promise<{ elements: KbElement[]; pagesRead: number[] }> {
  const subset = await subsetPdf(new Uint8Array(buffer), pages);
  const raw = await reader.partition({
    buffer: subset,
    filename: filename.replace(/[^\w.-]+/g, '_'),
    type: 'application/pdf',
  });
  const pagesRead = [
    ...new Set(raw.map((element) => pages[(element.metadata?.page_number ?? 1) - 1])),
  ].filter((page): page is number => page != null);
  return { elements: ocrToElements(raw, pages), pagesRead };
}
