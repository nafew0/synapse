import type { KbChunk, KbElement } from './types';

/** Characters, not tokens: Bangla runs about 2–3 characters per token, English about 4. */
export const KB_TEXT_BUDGET = 1800;
export const KB_TABLE_BUDGET = 2400;

const SENTENCE_END = /(?<=[।.!?])\s+/;

type Section = { text: string; level: number };
type Draft = Omit<KbChunk, 'index' | 'embedText'>;

const escapeCell = (cell: string): string => cell.replace(/\|/g, '\\|');
const markdownRow = (cells: string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;

/** Splits text longer than the budget at sentence ends, then hard at the budget. */
function splitLong(text: string, budget: number): string[] {
  if (text.length <= budget) {
    return [text];
  }
  const pieces: string[] = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_END)) {
    if (current && current.length + sentence.length + 1 > budget) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${sentence}` : sentence;
    while (current.length > budget) {
      pieces.push(current.slice(0, budget));
      current = current.slice(budget);
    }
  }
  return current ? [...pieces, current] : pieces;
}

/** Row groups that each repeat the table's header, so a row is never read without it. */
function tableDrafts(table: Extract<KbElement, { kind: 'table' }>, sectionPath: string): Draft[] {
  const hasHeader = table.header.some(Boolean);
  const head = hasHeader
    ? `${markdownRow(table.header)}\n${markdownRow(table.header.map(() => '---'))}\n`
    : '';
  const page = { pageStart: table.pageStart, pageEnd: table.pageEnd };
  const drafts: Draft[] = [];
  let lines: string[] = [];
  let size = head.length;
  const flush = () => {
    if (lines.length > 0) {
      drafts.push({ kind: 'table', sectionPath, ...page, text: head + lines.join('\n') });
    }
    lines = [];
    size = head.length;
  };
  for (const row of table.rows) {
    const line = markdownRow(row);
    if (lines.length > 0 && size + line.length + 1 > KB_TABLE_BUDGET) {
      flush();
    }
    lines.push(line);
    size += line.length + 1;
  }
  flush();
  return drafts;
}

/**
 * Cuts parsed elements into chunks that never cross a heading, never split a table row from
 * its header, and carry the document title and section path in what gets embedded.
 */
export function chunkElements(title: string, elements: KbElement[]): KbChunk[] {
  const drafts: Draft[] = [];
  const sections: Section[] = [];
  let paragraphs: string[] = [];
  let pageStart: number | null = null;
  let pageEnd: number | null = null;

  const sectionPath = (): string => sections.map((section) => section.text).join(' › ');

  const flushText = () => {
    if (paragraphs.length > 0) {
      drafts.push({
        kind: 'text',
        sectionPath: sectionPath(),
        pageStart,
        pageEnd,
        text: paragraphs.join('\n\n'),
      });
    }
    paragraphs = [];
    pageStart = null;
    pageEnd = null;
  };

  const addText = (text: string, page: number | null) => {
    for (const piece of splitLong(text, KB_TEXT_BUDGET)) {
      const size = paragraphs.reduce((total, p) => total + p.length + 2, 0);
      if (paragraphs.length > 0 && size + piece.length > KB_TEXT_BUDGET) {
        flushText();
      }
      paragraphs.push(piece);
      pageStart ??= page;
      pageEnd = page ?? pageEnd;
    }
  };

  for (const element of elements) {
    if (element.kind === 'heading') {
      flushText();
      while (sections.length > 0 && sections[sections.length - 1].level >= element.level) {
        sections.pop();
      }
      sections.push({ text: element.text, level: element.level });
      continue;
    }
    if (element.kind === 'table') {
      flushText();
      drafts.push(...tableDrafts(element, sectionPath()));
      continue;
    }
    addText(element.text, element.page);
  }
  flushText();

  return drafts.map((draft, index) => {
    const context = [title, draft.sectionPath].filter(Boolean).join(' › ');
    return { ...draft, index, embedText: `${context}\n\n${draft.text}` };
  });
}
