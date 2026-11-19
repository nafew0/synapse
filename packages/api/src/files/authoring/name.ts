const MAX_NAME_LENGTH = 120;
const EDITED_SUFFIX = '-edited';

/** Characters that are unsafe in a download name on common file systems, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** Splits `report.v2.py` into `report.v2` and `py`; a name without an extension has `ext` `''`. */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return { stem: name, ext: '' };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * Reduces a model-supplied name to a safe base name: the last path segment, unsafe characters
 * replaced, at most {@link MAX_NAME_LENGTH} characters with the extension kept.
 */
export function cleanFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(UNSAFE_NAME_CHARS, '_').trim();
  const { stem, ext } = splitName(base.replace(/^\.+/, ''));
  const room = MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0);
  const shortStem = stem.slice(0, Math.max(room, 1));
  return ext ? `${shortStem}.${ext}` : shortStem;
}

/** Forces `name` to end in `.ext`, replacing a different extension. */
export function withExtension(name: string, ext: string): string {
  if (!ext) {
    return name;
  }
  const { stem, ext: current } = splitName(name);
  return current.toLowerCase() === ext.toLowerCase() ? name : `${stem}.${ext}`;
}

/** Appends `-2`, `-3`, … to the stem until the name is not in `taken` (compared case-insensitively). */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) {
    return name;
  }
  const { stem, ext } = splitName(name);
  for (let n = 2; ; n++) {
    const candidate = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/**
 * Names the edited copy of `source`: the model's `requested` name when given, otherwise
 * `<stem>-edited.<ext>`. The source's extension is always kept, so an edit returns the same format,
 * and the result never repeats a name already used in the conversation.
 */
export function editedName({
  source,
  requested,
  taken,
}: {
  source: string;
  requested?: string;
  taken: ReadonlySet<string>;
}): string {
  const { stem, ext } = splitName(cleanFileName(source));
  const base = stem.endsWith(EDITED_SUFFIX) ? stem : `${stem}${EDITED_SUFFIX}`;
  const fallback = ext ? `${base}.${ext}` : base;
  const cleaned = requested ? cleanFileName(requested) : '';
  const chosen = cleaned && cleaned.toLowerCase() !== source.toLowerCase() ? cleaned : fallback;
  return uniqueName(withExtension(chosen, ext), taken);
}
