import { drawGrid, drawPage, drawPicture, PREVIEW_WIDTH } from './draw';
import { readEmbeddedThumbnail } from './office';
import { readLeadPicture, readParagraphs } from './word';
import { readSheet } from './sheet';

/** Reading a huge file into memory for a small picture is not worth it. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/** Files whose editor saves a usable preview picture inside them. */
const PICTURE_EXTENSIONS = new Set(['pptx', 'pptm', 'odt', 'odp', 'ods']);
const WORD_EXTENSIONS = new Set(['docx', 'docm']);
const EXCEL_EXTENSIONS = new Set(['xlsx', 'xlsm']);

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
  return renderPdfPage(data, PREVIEW_WIDTH);
};

const create = async (file: File): Promise<string | null> => {
  if (file.size > MAX_SOURCE_BYTES) {
    return null;
  }
  if (isPdf(file)) {
    return renderPdf(await readBytes(file));
  }
  const extension = extensionOf(file.name);
  if (WORD_EXTENSIONS.has(extension)) {
    const data = await readBytes(file);
    const paragraphs = readParagraphs(data);
    if (paragraphs.length > 0) {
      return drawPage(paragraphs);
    }
    const picture = readLeadPicture(data);
    return picture ? drawPicture(picture) : null;
  }
  if (EXCEL_EXTENSIONS.has(extension)) {
    const sheet = readSheet(await readBytes(file));
    return sheet ? drawGrid(sheet) : null;
  }
  if (PICTURE_EXTENSIONS.has(extension)) {
    return readEmbeddedThumbnail(await readBytes(file));
  }
  return null;
};

const cache = new WeakMap<File, Promise<string | null>>();

/**
 * A small picture of a document's first page, as a data URL: drawn with pdf.js for PDFs, drawn
 * from the text (or, for a scan, the picture) of Word files and the cells of Excel files, and read
 * from the preview picture PowerPoint and OpenDocument files carry. Resolves to null when there is
 * none or the file cannot be read. Each file is drawn once, however often its tile mounts.
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

/** Upper bound on remembered thumbnails; each is a few tens of kilobytes. */
const MAX_REMEMBERED = 100;
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
