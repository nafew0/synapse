import type {
  KbParsed,
  KbElement,
  DoclingNode,
  DoclingDocument,
  DoclingTextItem,
  DoclingTableItem,
} from './types';
import { cleanCell, cleanText } from './normalize';

const SKIPPED_TEXT = new Set(['page_header', 'page_footer']);
const HEADING_TEXT = new Set(['title', 'section_header']);

const firstPage = (node: DoclingNode): number | null => node.prov?.[0]?.page_no ?? null;
const lastPage = (node: DoclingNode): number | null =>
  node.prov?.[node.prov.length - 1]?.page_no ?? null;

/** Rebuilds the table as rows, leaving the cells a merged cell covers empty instead of repeated. */
function tableRows(table: DoclingTableItem): string[][] {
  return table.data.grid.map((row, r) =>
    row.map((cell, c) =>
      cell.start_row_offset_idx === r && cell.start_col_offset_idx === c
        ? cleanCell(cell.text)
        : '',
    ),
  );
}

/** Leading rows Docling marked as column headers, folded into one header row. */
function splitHeader(
  table: DoclingTableItem,
  rows: string[][],
): { header: string[]; body: string[][] } {
  let count = 0;
  while (count < rows.length - 1 && table.data.grid[count].some((cell) => cell.column_header)) {
    count++;
  }
  const header = rows[0].map((_, c) =>
    rows
      .slice(0, count)
      .map((row) => row[c])
      .filter(Boolean)
      .join(' / '),
  );
  return { header, body: rows.slice(count) };
}

function tableElements(table: DoclingTableItem): KbElement[] {
  const rows = tableRows(table).filter((row) => row.some(Boolean));
  if (rows.length === 0) {
    return [];
  }
  const page = firstPage(table);
  /* Letterheads, memo lines and signature blocks are laid out as one-row or one-column tables. */
  if (rows.length < 2 || table.data.num_cols < 2) {
    return rows
      .flat()
      .filter(Boolean)
      .map((text): KbElement => ({ kind: 'text', text, page }));
  }
  const { header, body } = splitHeader(table, rows);
  return [{ kind: 'table', header, rows: body, pageStart: page, pageEnd: lastPage(table) }];
}

function textElement(item: DoclingTextItem): KbElement | null {
  if (SKIPPED_TEXT.has(item.label)) {
    return null;
  }
  const text = cleanText(item.text);
  if (!text) {
    return null;
  }
  const page = firstPage(item);
  if (HEADING_TEXT.has(item.label)) {
    return { kind: 'heading', text, level: item.label === 'title' ? 0 : (item.level ?? 1), page };
  }
  return { kind: 'text', text: item.label === 'list_item' ? `• ${text}` : text, page };
}

/**
 * Turns a DoclingDocument into reading-order elements. Tables are read from their grid, so
 * the rich-cell groups under them are not walked again. An XLSX sheet becomes a heading.
 */
export function toElements(doc: DoclingDocument & { pages?: Record<string, unknown> }): KbParsed {
  const nodes = new Map<string, DoclingNode>();
  for (const node of [...doc.groups, ...doc.texts, ...doc.tables, ...doc.pictures]) {
    nodes.set(node.self_ref, node);
  }

  const elements: KbElement[] = [];
  let pageCount = Object.keys(doc.pages ?? {}).length;

  const visit = (node: DoclingNode): void => {
    if (node.content_layer === 'furniture') {
      return;
    }
    for (const prov of node.prov ?? []) {
      pageCount = Math.max(pageCount, prov.page_no);
    }
    if (node.self_ref.startsWith('#/tables/')) {
      elements.push(...tableElements(node as DoclingTableItem));
      return;
    }
    if (node.self_ref.startsWith('#/texts/')) {
      const element = textElement(node as DoclingTextItem);
      if (element) {
        elements.push(element);
      }
    }
    if (node.label === 'sheet' && node.name) {
      elements.push({ kind: 'heading', text: cleanText(node.name), level: 1, page: null });
    }
    for (const child of node.children ?? []) {
      const next = nodes.get(child.$ref);
      if (next) {
        visit(next);
      }
    }
  };

  visit(doc.body);
  return { elements, pageCount };
}
