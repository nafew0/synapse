import { readEmbeddedThumbnail } from './office';

/** Twice the 56px tile, so the page stays sharp on high-density screens. */
const THUMBNAIL_WIDTH = 112;
/** Reading a huge file into memory for a 56px picture is not worth it. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods']);

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

const readBytes = (file: File): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

const isPdf = (file: File) => file.type === 'application/pdf' || extensionOf(file.name) === 'pdf';

/** pdf.js is large, so it loads only once someone attaches a PDF. */
const renderPdf = async (data: ArrayBuffer) => {
  const { renderPdfPage } = await import('./pdf');
  return renderPdfPage(data, THUMBNAIL_WIDTH);
};

const create = async (file: File): Promise<string | null> => {
  if (file.size > MAX_SOURCE_BYTES) {
    return null;
  }
  if (isPdf(file)) {
    return renderPdf(await readBytes(file));
  }
  if (OFFICE_EXTENSIONS.has(extensionOf(file.name))) {
    return readEmbeddedThumbnail(await readBytes(file));
  }
  return null;
};

const cache = new WeakMap<File, Promise<string | null>>();

/**
 * A small picture of a document's first page, as a data URL: drawn with pdf.js for PDFs, read from
 * the preview picture Office and OpenDocument files carry. Resolves to null when there is none or
 * the file cannot be read. Each file is drawn once, however often its tile mounts.
 */
export function getThumbnail(file: File): Promise<string | null> {
  const cached = cache.get(file);
  if (cached) {
    return cached;
  }
  const pending = create(file).catch(() => null);
  cache.set(file, pending);
  return pending;
}

/** Upper bound on remembered thumbnails; each is a few kilobytes. */
const MAX_REMEMBERED = 200;
const byId = new Map<string, string>();

/**
 * Keeps a drawn thumbnail under the attachment's id. Once an upload finishes, the composer swaps
 * the local record (which holds the `File`) for the server's copy, which only carries the ids.
 */
export function rememberThumbnail(fileId: string, url: string): void {
  byId.delete(fileId);
  byId.set(fileId, url);
  if (byId.size > MAX_REMEMBERED) {
    const oldest = byId.keys().next().value;
    if (oldest != null) {
      byId.delete(oldest);
    }
  }
}

/** The thumbnail remembered under any of the attachment's ids. */
export function findThumbnail(...ids: Array<string | undefined>): string | null {
  for (const id of ids) {
    const url = id ? byId.get(id) : undefined;
    if (url) {
      return url;
    }
  }
  return null;
}
