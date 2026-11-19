import { unzipSync, strFromU8 } from 'fflate';

/** Inflates only the entries `wanted` accepts; a damaged archive gives none. */
export function unzipEntries(
  data: ArrayBuffer,
  wanted: (name: string) => boolean,
): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(data), { filter: (entry) => wanted(entry.name) });
  } catch {
    return {};
  }
}

/** The named entries as text, keyed by name; missing entries are left out. */
export function readTexts(data: ArrayBuffer, names: readonly string[]): Record<string, string> {
  const wanted = new Set(names);
  const entries = unzipEntries(data, (name) => wanted.has(name));
  return Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [name, strFromU8(bytes)]),
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Turns XML character references back into text. */
export const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, ref: string) => {
    if (ref[0] !== '#') {
      return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
    }
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
