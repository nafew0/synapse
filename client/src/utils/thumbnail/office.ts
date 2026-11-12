import { unzipEntries } from './zip';

/**
 * Where Office and OpenDocument files keep the preview picture their editor saved. PowerPoint
 * writes one only when "Save preview picture" is on; LibreOffice always writes one. Word's is left
 * out on purpose: Word for Mac saves the same blank page into every file.
 */
const THUMBNAIL_PATHS: Record<string, string> = {
  'docProps/thumbnail.jpeg': 'image/jpeg',
  'docProps/thumbnail.jpg': 'image/jpeg',
  'docProps/thumbnail.png': 'image/png',
  'Thumbnails/thumbnail.png': 'image/png',
};

const toDataUrl = (bytes: Uint8Array, mime: string): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
};

/**
 * The preview picture stored inside an Office or OpenDocument file, if it has one. Only that entry
 * is inflated, so reading it synchronously stays cheap even for a large file.
 */
export function readEmbeddedThumbnail(data: ArrayBuffer): string | null {
  const entries = unzipEntries(data, (name) => name in THUMBNAIL_PATHS);
  const name = Object.keys(entries)[0];
  return name ? toDataUrl(entries[name], THUMBNAIL_PATHS[name]) : null;
}
