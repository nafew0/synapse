export const isHttpDownloadTarget = (target?: string | null): boolean =>
  /^https?:\/\//i.test(target ?? '');

/** Matches the `<file_id>-` storage-key prefix the backend prepends to stored filenames
 * (see `saveBase64Image`/`processImageFile` in `api/server/services/Files/process.js`) so
 * files with the same name don't collide on disk/S3. */
const STORAGE_ID_PREFIX = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
const DOWNLOAD_ID_SUFFIX_LENGTH = 6;

/**
 * Turns a stored filename into the name the browser should save it under: the leading
 * storage id moves to a short tail, so `<file_id>-red-panda-eating-bamboo.png` saves as
 * `red-panda-eating-bamboo-4f3a2b.png` — descriptive, but still unique per file.
 *
 * The tail is load-bearing, not decoration: a thread regenerating the same prompt, or one
 * request fanning out into parallel image tool calls, produces several files whose
 * descriptive part is identical. Without it they would overwrite each other on download.
 */
export function toDownloadFilename(filename: string): string {
  const match = filename.match(STORAGE_ID_PREFIX);
  if (!match) {
    return filename;
  }

  const rest = filename.slice(match[0].length);
  if (!rest) {
    return filename;
  }

  const suffix = match[1].slice(0, DOWNLOAD_ID_SUFFIX_LENGTH);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) {
    return `${rest}-${suffix}`;
  }

  return `${rest.slice(0, dot)}-${suffix}${rest.slice(dot)}`;
}

/**
 * Maps a fenced-block language hint to a file extension. Used to name
 * downloads of chat code blocks (`code.<ext>`). Only languages whose common
 * name differs from their extension need an entry; hints that already look
 * like an extension (`py`, `ts`, `json`) pass through unchanged.
 */
const LANGUAGE_TO_EXTENSION: Record<string, string> = {
  javascript: 'js',
  node: 'js',
  nodejs: 'js',
  typescript: 'ts',
  python: 'py',
  python3: 'py',
  golang: 'go',
  ruby: 'rb',
  perl: 'pl',
  rust: 'rs',
  'c++': 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  objectivec: 'm',
  kotlin: 'kt',
  julia: 'jl',
  elixir: 'ex',
  erlang: 'erl',
  haskell: 'hs',
  clojure: 'clj',
  fsharp: 'fs',
  'f#': 'fs',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  batch: 'bat',
  graphql: 'graphql',
  protobuf: 'proto',
  markdown: 'md',
  yaml: 'yaml',
  yml: 'yaml',
  plaintext: 'txt',
  text: 'txt',
};

/**
 * Builds a download filename for a chat code block from its fenced-block
 * language hint. Unknown-but-extension-like hints are used verbatim so a
 * ```` ```toml ```` block still downloads as `code.toml`; anything else
 * falls back to `code.txt`.
 */
export function getCodeBlockFilename(lang?: string | null): string {
  const hint = (lang ?? '').trim().toLowerCase();
  const mapped = Object.prototype.hasOwnProperty.call(LANGUAGE_TO_EXTENSION, hint)
    ? LANGUAGE_TO_EXTENSION[hint]
    : undefined;
  const extension = mapped ?? (/^[a-z0-9]{1,11}$/.test(hint) ? hint : 'txt');
  return `code.${extension}`;
}

export function triggerDownload(target: string, filename: string): void {
  const isBlob = target.startsWith('blob:');
  const link = document.createElement('a');
  link.href = target;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (isBlob) {
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  }
}
