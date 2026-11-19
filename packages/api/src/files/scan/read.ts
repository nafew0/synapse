import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PageKind, PageOps, PageSignals } from './classify';
import { classifyPage, measureOperators } from './classify';

export interface PdfPages {
  /** One entry per page: its text items joined by spaces. */
  texts: string[];
  kinds: PageKind[];
}

/** Reads a page's drawing operators. If they cannot be read, assume a picture rather than miss a scan. */
async function measurePage(page: PDFPageProxy, ops: PageOps): Promise<Omit<PageSignals, 'text'>> {
  try {
    const { fnArray, argsArray } = await page.getOperatorList();
    const [x0, y0, x1, y1] = page.view;
    return measureOperators({ fnArray, argsArray, ops, pageArea: (x1 - x0) * (y1 - y0) });
  } catch {
    return { imageCoverage: 1, hiddenText: false, pathCount: 0, glyphCount: 0 };
  }
}

/** Reads each page's text and verdict in one walk over the pages. */
export async function readPdfPages(data: Uint8Array, minCharsPerPage: number): Promise<PdfPages> {
  // Imported inline so that Jest can test other routes without failing due to loading ESM
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data }).promise;

  const texts: string[] = [];
  const kinds: PageKind[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const strings = textContent.items
      .filter((item): item is TextItem => !('type' in item))
      .map((item) => item.str);
    texts.push(strings.join(' '));
    const measured = await measurePage(page, OPS);
    kinds.push(classifyPage({ text: strings.join(''), ...measured }, minCharsPerPage));
    page.cleanup();
  }
  return { texts, kinds };
}
