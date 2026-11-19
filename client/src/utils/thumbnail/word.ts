import { readTexts, unzipEntries } from './zip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const DOCUMENT = 'word/document.xml';
const RELATIONS = 'word/_rels/document.xml.rels';
const MAX_PARAGRAPHS = 40;
const BODY_PT = 11;

export type Alignment = 'left' | 'center' | 'right';

export type Paragraph = {
  text: string;
  /** Font size in points. */
  size: number;
  bold: boolean;
  align: Alignment;
};

/** Built-in Word style ids and the sizes they use in the default template. */
const STYLE_SIZES: Array<[RegExp, number]> = [
  [/^title$/i, 26],
  [/^subtitle$/i, 15],
  [/^heading\s?1$/i, 16],
  [/^heading\s?2$/i, 13],
  [/^heading\s?\d$/i, 12],
];

const ALIGNMENTS: Record<string, Alignment> = { center: 'center', right: 'right', end: 'right' };

const isWord = (node: Element, name: string) => node.namespaceURI === W && node.localName === name;

const child = (parent: Element | null | undefined, name: string): Element | null => {
  if (!parent) {
    return null;
  }
  for (const node of Array.from(parent.children)) {
    if (isWord(node, name)) {
      return node;
    }
  }
  return null;
};

const valueOf = (node: Element | null): string | null => node?.getAttributeNS(W, 'val') ?? null;

/** A toggle like `<w:b/>` is on unless its value says otherwise. */
const isOn = (node: Element | null): boolean =>
  node != null && !['0', 'false', 'off'].includes(valueOf(node) ?? '');

/** The paragraph a run belongs to, so runs in text boxes nested inside a run are not counted twice. */
const owningParagraph = (run: Element): Element | null => {
  let node = run.parentElement;
  while (node && !isWord(node, 'p')) {
    node = node.parentElement;
  }
  return node;
};

const runText = (run: Element): string =>
  Array.from(run.children)
    .map((node) => {
      if (isWord(node, 't')) {
        return node.textContent ?? '';
      }
      return isWord(node, 'tab') || isWord(node, 'br') || isWord(node, 'cr') ? ' ' : '';
    })
    .join('');

const styleSize = (style: string): number | undefined =>
  STYLE_SIZES.find(([pattern]) => pattern.test(style))?.[1];

const readParagraph = (paragraph: Element): Paragraph => {
  const properties = child(paragraph, 'pPr');
  const style = valueOf(child(properties, 'pStyle')) ?? '';
  const runs = Array.from(paragraph.getElementsByTagNameNS(W, 'r')).filter(
    (run) => owningParagraph(run) === paragraph,
  );

  let text = '';
  let lead: Element | null = null;
  for (const run of runs) {
    const piece = runText(run);
    if (lead == null && piece.trim()) {
      lead = child(run, 'rPr');
    }
    text += piece;
  }

  const format = lead ?? child(properties, 'rPr');
  const halfPoints = Number(valueOf(child(format, 'sz')));
  const size = halfPoints > 0 ? halfPoints / 2 : (styleSize(style) ?? BODY_PT);
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    size,
    bold: isOn(child(format, 'b')) || /^(title|heading)/i.test(style),
    align: ALIGNMENTS[valueOf(child(properties, 'jc')) ?? ''] ?? 'left',
  };
};

/**
 * The opening paragraphs of a Word document with the formatting a small preview can show: size,
 * weight and alignment. Runs of empty paragraphs collapse to one; an empty document gives none.
 */
export function readParagraphs(data: ArrayBuffer): Paragraph[] {
  const xml = readTexts(data, [DOCUMENT])[DOCUMENT];
  if (!xml) {
    return [];
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return [];
  }
  /** Shapes are stored twice, the second copy for old readers; keep only the first. */
  for (const fallback of Array.from(doc.getElementsByTagNameNS(MC, 'Fallback'))) {
    fallback.remove();
  }

  const paragraphs: Paragraph[] = [];
  let hasText = false;
  for (const node of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    const paragraph = readParagraph(node);
    const previous = paragraphs[paragraphs.length - 1];
    if (!paragraph.text && (previous == null || !previous.text)) {
      continue;
    }
    hasText ||= paragraph.text.length > 0;
    paragraphs.push(paragraph);
    if (paragraphs.length >= MAX_PARAGRAPHS) {
      break;
    }
  }
  return hasText ? paragraphs : [];
}

const PICTURE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

export type Picture = { bytes: Uint8Array; type: string };

/**
 * The first picture placed in a Word document, for documents that are a scan with no text. Gives
 * null when there is none, or when it is a format browsers cannot draw (EMF, WMF).
 */
export function readLeadPicture(data: ArrayBuffer): Picture | null {
  const parts = readTexts(data, [DOCUMENT, RELATIONS]);
  const id = parts[DOCUMENT]?.match(/<a:blip\b[^>]*?\br:embed="([^"]+)"/)?.[1];
  const relation = Array.from((parts[RELATIONS] ?? '').matchAll(/<Relationship\b([^>]*)>/g))
    .map((match) => match[1])
    .find((tag) => tag.includes(`Id="${id}"`));
  const target = relation?.match(/\bTarget="([^"]+)"/)?.[1];
  if (!id || !target || /^[a-z]+:/i.test(target)) {
    return null;
  }
  const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
  const type = PICTURE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  const bytes = type ? unzipEntries(data, (name) => name === path)[path] : undefined;
  return bytes ? { bytes, type } : null;
}
