/** Bangla vowel signs, candrabindu/anusvara/visarga, nukta, hasanta and au length mark. */
const MARK =
  '[\\u0981-\\u0983\\u09BC\\u09BE-\\u09C4\\u09C7\\u09C8\\u09CB-\\u09CD\\u09D7\\u09E2\\u09E3]';
const GAP = '[ \\t\\u00A0]+';
/** A mark set apart on both sides ("খ ু লবে") joins the consonant before and the one after. */
const ISOLATED_MARK = new RegExp(`${GAP}(${MARK})${GAP}`, 'g');
/** A mark set apart only before it ("ক ি") joins the consonant before. */
const DETACHED_MARK = new RegExp(`${GAP}(?=${MARK})`, 'g');
const DOTTED_CIRCLE = /\u25CC/g;
const SPACES = /[ \t\u00A0]+/g;
const BLANK_LINES = /\n{3,}/g;

/**
 * Cleans text read from a PDF text layer or an Office file for display and embedding.
 * Text layers often split a Bangla vowel sign from its consonant or keep the dotted circle a
 * font drew for it. Search-side folding (digits, joiners) happens in the RAG API, so the index
 * and the query are folded by the same code.
 */
export function cleanText(text: string): string {
  return text
    .normalize('NFC')
    .replace(DOTTED_CIRCLE, '')
    .replace(ISOLATED_MARK, '$1')
    .replace(DETACHED_MARK, '')
    .replace(SPACES, ' ')
    .replace(/ *\n */g, '\n')
    .replace(BLANK_LINES, '\n\n')
    .trim();
}

/** A table cell on one line. */
export const cleanCell = (text: string): string => cleanText(text).replace(/\s*\n\s*/g, ' ');
