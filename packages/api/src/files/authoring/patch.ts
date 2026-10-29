export interface FileEdit {
  /** Exact text to find; must occur exactly once in the file at the time it is applied. */
  old: string;
  /** Replacement text; may be empty to delete `old`. */
  new: string;
}

export type PatchResult = { ok: true; content: string } | { ok: false; error: string };

/** Counts non-overlapping occurrences of `needle`, stopping at two since only "exactly one" matters. */
function countUpToTwo(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle);
  if (first === -1) {
    return 0;
  }
  return haystack.indexOf(needle, first + needle.length) === -1 ? 1 : 2;
}

/** Converts bare `\n` to `\r\n` without doubling existing `\r\n`. */
const toCrlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

/**
 * Applies find-and-replace edits in order. Each `old` must match exactly once, so an edit never
 * lands in the wrong place: a missing or repeated match fails the whole patch and leaves the
 * content unchanged. In a file with Windows line endings, edits written with `\n` still match.
 */
export function applyEdits(content: string, edits: FileEdit[]): PatchResult {
  if (edits.length === 0) {
    return { ok: false, error: 'No edits were given.' };
  }
  const crlf = content.includes('\r\n');
  let result = content;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.old === '') {
      return {
        ok: false,
        error: `Edit ${i + 1}: "old" is empty. Quote the exact text to replace.`,
      };
    }
    const oldText = crlf ? toCrlf(edit.old) : edit.old;
    const newText = crlf ? toCrlf(edit.new) : edit.new;
    const matches = countUpToTwo(result, oldText);
    if (matches === 0) {
      return {
        ok: false,
        error: `Edit ${i + 1}: the "old" text was not found. Read the file again and copy the text exactly, including spaces and indentation.`,
      };
    }
    if (matches > 1) {
      return {
        ok: false,
        error: `Edit ${i + 1}: the "old" text appears more than once. Include more surrounding lines so it matches only one place.`,
      };
    }
    const at = result.indexOf(oldText);
    result = result.slice(0, at) + newText + result.slice(at + oldText.length);
  }
  return { ok: true, content: result };
}
