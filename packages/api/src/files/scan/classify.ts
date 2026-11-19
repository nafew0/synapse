import type { FilePageScan } from 'librechat-data-provider';

export type PageKind = 'text' | 'scan' | 'garbled';

/** What one page's text and drawing operators say about it. */
export interface PageSignals {
  /** Text items joined without separators, so glyph-by-glyph runs still form whole words. */
  text: string;
  /** Share of the page painted by images, 0 to 1. */
  imageCoverage: number;
  /** Text nobody can see: invisible, or painted under a full-page image. A scanner's own OCR layer. */
  hiddenText: boolean;
  /** Vector paths on the page; text converted to outlines has hundreds and no characters. */
  pathCount: number;
  /** Glyphs the page draws as text, spaces included, whether or not they map to characters. */
  glyphCount: number;
}

/** The subset of pdf.js `OPS` the measurement reads. */
export interface PageOps {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  setTextRenderingMode: number;
  showText: number;
  showSpacedText: number;
  constructPath: number;
}

type Matrix = number[];

const FULL_PAGE_COVERAGE = 0.9;
const MOSTLY_IMAGE_COVERAGE = 0.6;
const THIN_PAGE_IMAGE_COVERAGE = 0.25;
const MOSTLY_IMAGE_MAX_CHARS = 500;
const OUTLINED_TEXT_MIN_PATHS = 200;
const INVISIBLE_TEXT_MODES = new Set([3, 7]);
/**
 * Below this many characters read per glyph drawn, most of the page's text has no characters behind
 * it, as when a font maps its glyphs to nothing. Readable PDFs measured 0.62 or more over 1,725 pages
 * (spaces and conjuncts make it below 1); a notice whose body was lost measured 0.18.
 */
const MIN_CHARS_PER_GLYPH = 0.4;
const LOST_TEXT_MIN_GLYPHS = 100;

/** Share of a page's characters that must be damaged before it counts as unreadable. */
const GARBLED_MIN_SHARE = 0.02;
/** A source may carry a typo or two of its own. Matches `verify_conversion.py`'s MAX_DRAWN_ORDER. */
const MAX_DRAWN_ORDER = 2;
const BIJOY_MIN_MARKERS = 5;
const BIJOY_MIN_SHARE = 0.01;

/** pdf.js hands an unmapped Bangla conjunct back as a control character. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000e-\u001f]/g;
const UNMAPPED_CHARS = /[-�]/g;
/** A dependent vowel sign starting a word: Bangla copied in drawn order. Typed Bangla never has one. */
const DRAWN_ORDER = /(?:^|[\s([‘“"'/-])[া-ৌৗ]/gu;
/** Bijoy (SutonnyMJ) stores Bangla as Latin code points; these punctuation marks stand for its conjuncts. */
const BIJOY_MARKERS = /[‡†¨¦¯‰Š]/g;

const countMatches = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/**
 * Whether a page has a text layer no reader can use. The character count cannot see this: the
 * damage has as many characters as the real text would.
 */
export function isGarbled(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  if (compact.length === 0) {
    return false;
  }
  const damaged = countMatches(compact, CONTROL_CHARS) + countMatches(compact, UNMAPPED_CHARS);
  if (damaged / compact.length >= GARBLED_MIN_SHARE) {
    return true;
  }
  if (countMatches(text, DRAWN_ORDER) > MAX_DRAWN_ORDER) {
    return true;
  }
  const bijoy = countMatches(compact, BIJOY_MARKERS);
  return bijoy >= BIJOY_MIN_MARKERS && bijoy / compact.length >= BIJOY_MIN_SHARE;
}

/** Sorts a page by whether its text can be used as it is. Order matters: see each rule. */
export function classifyPage(signals: PageSignals, minChars: number): PageKind {
  const { text, imageCoverage, hiddenText, pathCount, glyphCount } = signals;
  /* However many characters it has, this is a scanner's guess at the picture on top of it. */
  if (hiddenText && imageCoverage >= FULL_PAGE_COVERAGE) {
    return 'scan';
  }
  const chars = text.replace(/\s/g, '').length;
  /* What text it gives may also be garbled, but no repair can bring back what it never gives. */
  if (glyphCount >= LOST_TEXT_MIN_GLYPHS && chars / glyphCount < MIN_CHARS_PER_GLYPH) {
    return 'scan';
  }
  if (isGarbled(text)) {
    return 'garbled';
  }
  if (chars < minChars) {
    /* A cover or separator page is short with nothing to read in it; do not pay to OCR those. */
    const hasPicture = imageCoverage >= THIN_PAGE_IMAGE_COVERAGE;
    return hasPicture || pathCount >= OUTLINED_TEXT_MIN_PATHS ? 'scan' : 'text';
  }
  return imageCoverage >= MOSTLY_IMAGE_COVERAGE && chars < MOSTLY_IMAGE_MAX_CHARS ? 'scan' : 'text';
}

/** pdf.js passes a shown string as glyph objects, with numbers between them for spacing. */
const countGlyphs = (glyphs: unknown): number =>
  Array.isArray(glyphs)
    ? glyphs.reduce<number>(
        (count, glyph) => (glyph && typeof glyph === 'object' ? count + 1 : count),
        0,
      )
    : 0;

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  0,
  0,
];

/** One pass over a page's drawing operators. An image fills its unit square, scaled by the CTM. */
export function measureOperators({
  fnArray,
  argsArray,
  ops,
  pageArea,
}: {
  fnArray: number[];
  argsArray: unknown[][];
  ops: PageOps;
  pageArea: number;
}): Omit<PageSignals, 'text'> {
  const images = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let imageArea = 0;
  let pathCount = 0;
  let glyphCount = 0;
  let textMode = 0;
  let textShown = false;
  let hiddenText = false;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === ops.transform) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      ctm = Array.isArray(args?.[0]) ? multiply(ctm, args[0] as Matrix) : ctm;
    } else if (fn === ops.setTextRenderingMode) {
      textMode = args[0] as number;
    } else if (fn === ops.showText || fn === ops.showSpacedText) {
      textShown = true;
      hiddenText = hiddenText || INVISIBLE_TEXT_MODES.has(textMode);
      glyphCount += countGlyphs(args?.[0]);
    } else if (fn === ops.constructPath) {
      pathCount++;
    } else if (images.has(fn)) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      imageArea += area;
      hiddenText = hiddenText || (textShown && area / pageArea >= FULL_PAGE_COVERAGE);
    }
  }

  return { imageCoverage: Math.min(imageArea / pageArea, 1), hiddenText, pathCount, glyphCount };
}

/** The record stored with a file: 1-based pages that need OCR, and which of those are garbled. */
export function summarizeScan(kinds: PageKind[]): FilePageScan {
  const ocrPages: number[] = [];
  const garbledPages: number[] = [];
  kinds.forEach((kind, index) => {
    if (kind === 'text') {
      return;
    }
    ocrPages.push(index + 1);
    if (kind === 'garbled') {
      garbledPages.push(index + 1);
    }
  });
  return { pages: kinds.length, ocrPages, garbledPages };
}
