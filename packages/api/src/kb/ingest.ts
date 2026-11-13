import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { IKbIngestJob, KbMethods } from '@librechat/data-schemas';
import type { KbIndexClient } from './rag';
import type { KbChunk, KbElement, KbParsed } from './types';
import type { PageKind } from '~/files/scan/classify';
import type { KbOcrReader } from './ocr';
import { DoclingRejectedError, type DoclingClient } from './docling';
import { forgetInstitutionKb } from './availability';
import { chunkElements } from './chunk';
import { toElements } from './elements';
import { cleanText } from './normalize';
import { readPdfPagesWithOcr } from './ocr';

export const KB_PARSER = { name: 'docling-serve', version: '1.38.2' } as const;
const KB_PARSER_WITH_OCR = { name: 'docling-serve+unstructured', version: '1.38.2' } as const;

/** Types Docling reads natively, plus plain text, which needs no parser. */
export const KB_SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/html',
  'text/markdown',
  'text/csv',
  'text/plain',
]);

const DEFAULT_POLL_MS = 15_000;

export interface KbIngestDeps {
  methods: Pick<
    KbMethods,
    | 'claimKbIngestJob'
    | 'completeKbIngestJob'
    | 'failKbIngestJob'
    | 'getKbDocument'
    | 'getKbDocumentVersion'
    | 'updateKbDocument'
  >;
  docling: DoclingClient;
  index: KbIndexClient;
  readFile(fileRef: string): Promise<Buffer>;
  deleteFile(fileRef: string): Promise<void>;
  runAsSystem<T>(fn: () => Promise<T>): Promise<T>;
  runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  /** Reads scanned and garbled PDF pages; without it they stay unreadable. */
  ocr?: KbIngestOcr;
  /** Page kinds of a PDF (text, scan or garbled); defaults to the upload classifier. */
  classifyPages?: (buffer: Buffer) => Promise<PageKind[]>;
}

export interface KbIngestOcr extends KbOcrReader {
  /** Whether this institution may send pages out: its OCR switch and the deployment's config. */
  allowed(tenantId: string): Promise<boolean>;
  recordCharge(charge: {
    tenantId: string;
    documentId: string;
    version: number;
    userId: string | null;
    pages: number;
    contentHash: string;
  }): Promise<void>;
}

const OCR_MIN_CHARS_PER_PAGE = 50;

/** The upload classifier, loaded on use: pdfjs is ESM, which Jest cannot load. */
async function classifyWithPdfjs(buffer: Buffer): Promise<PageKind[]> {
  const { readPdfPages } = await import('~/files/scan/read');
  const { kinds } = await readPdfPages(new Uint8Array(buffer), OCR_MIN_CHARS_PER_PAGE);
  return kinds;
}

const pagesOf = (element: KbElement): (number | null)[] =>
  element.kind === 'table' ? [element.pageStart, element.pageEnd] : [element.page];

const firstPageOf = (element: KbElement): number => pagesOf(element)[0] ?? 0;

/** A failure that retrying the same job will not fix. */
class KbJobRejected extends Error {}

function parsePlainText(buffer: Buffer): KbParsed {
  const elements = buffer
    .toString('utf8')
    .split(/\n\s*\n/)
    .map((paragraph) => cleanText(paragraph))
    .filter(Boolean)
    .map((text) => ({ kind: 'text' as const, text, page: null }));
  return { elements, pageCount: 0 };
}

/** Pages no element came from: scans, which Docling does not read with OCR off. */
function unreadablePages({ elements, pageCount }: KbParsed): number[] {
  const read = new Set<number>();
  for (const element of elements) {
    pagesOf(element).forEach((page) => page != null && read.add(page));
  }
  return Array.from({ length: pageCount }, (_, i) => i + 1).filter((page) => !read.has(page));
}

async function runJob(job: IKbIngestJob, deps: KbIngestDeps): Promise<void> {
  const documentId = String(job.documentId);
  const [document, version] = await Promise.all([
    deps.methods.getKbDocument(documentId),
    deps.methods.getKbDocumentVersion(documentId, job.version),
  ]);
  if (!document || !version) {
    throw new KbJobRejected('The document or this version was deleted');
  }
  if (!KB_SUPPORTED_TYPES.has(version.mimeType)) {
    throw new KbJobRejected(`Unsupported file type ${version.mimeType}`);
  }

  const buffer = await deps.readFile(version.fileRef);
  let parsed =
    version.mimeType === 'text/plain'
      ? parsePlainText(buffer)
      : toElements(
          await deps.docling.convert({
            buffer,
            filename: version.filename,
            mimeType: version.mimeType,
          }),
        );
  let ocrUsed = false;
  let ocrOff = false;
  if (version.mimeType === 'application/pdf') {
    const result = await readScannedPages({ deps, job, parsed, buffer, version, documentId });
    parsed = result.parsed;
    ocrUsed = result.ocrUsed;
    ocrOff = result.ocrOff;
  }
  const title = await titleFromContent(deps, documentId, document.title, version.filename, parsed);
  const chunks: KbChunk[] = chunkElements(title, parsed.elements);
  const unreadable = unreadablePages(parsed);
  if (chunks.length === 0) {
    throw new KbJobRejected(noTextReason(unreadable.length > 0, ocrUsed, ocrOff));
  }

  const target = { tenantId: job.tenantId, documentId, version: job.version };
  await deps.index.upload({ ...target, title, docType: document.docType, chunks });
  await deps.index.activate(target);
  const { prunedFileRefs } = await deps.methods.completeKbIngestJob({
    jobId: job._id,
    pageCount: parsed.pageCount,
    chunkCount: chunks.length,
    unreadablePages: unreadable,
    parser: ocrUsed ? KB_PARSER_WITH_OCR : KB_PARSER,
  });
  forgetInstitutionKb(job.tenantId);
  await Promise.all(
    prunedFileRefs.map((fileRef) =>
      deps.deleteFile(fileRef).catch((error: Error) => {
        logger.warn(`[kb/ingest] could not delete old version ${fileRef}: ${error.message}`);
      }),
    ),
  );
  logger.info(
    `[kb/ingest] ${job.tenantId}/${documentId} v${job.version}: ${chunks.length} chunks, ${parsed.pageCount} pages`,
  );
}

const MAX_TITLE = 160;

/**
 * An upload without a title is named after its file, which models cannot match a question to
 * ("bYKKqv1DeY1594737831"). Such a document takes its first heading as its title instead.
 */
async function titleFromContent(
  deps: KbIngestDeps,
  documentId: string,
  title: string,
  filename: string,
  parsed: KbParsed,
): Promise<string> {
  if (title !== path.basename(filename, path.extname(filename))) {
    return title;
  }
  const heading = parsed.elements.find((element) => element.kind === 'heading');
  const named = heading?.kind === 'heading' ? heading.text.replace(/\s+/g, ' ').trim() : '';
  if (!named) {
    return title;
  }
  const next = named.slice(0, MAX_TITLE);
  await deps.methods.updateKbDocument(documentId, { title: next });
  return next;
}

function noTextReason(hasPages: boolean, ocrUsed: boolean, ocrOff: boolean): string {
  if (!hasPages) {
    return 'No readable text in this file';
  }
  if (ocrUsed) {
    return 'No readable text, even after reading the scanned pages';
  }
  if (ocrOff) {
    return 'This PDF is a scan (pictures of pages, no text). Reading scans needs document reading (OCR), which is off for this institution';
  }
  return 'This PDF is a scan (pictures of pages, no text), and scanned pages cannot be read on this server';
}

/**
 * Sends a PDF's scanned pages, and pages whose text layer is garbled (old Bangla encodings),
 * to OCR when the institution may use it. Garbled text is never indexed, read or not.
 */
async function readScannedPages({
  deps,
  job,
  parsed,
  buffer,
  version,
  documentId,
}: {
  deps: KbIngestDeps;
  job: IKbIngestJob;
  parsed: KbParsed;
  buffer: Buffer;
  version: { filename: string; sha256: string; uploadedBy?: unknown };
  documentId: string;
}): Promise<{ parsed: KbParsed; ocrUsed: boolean; ocrOff: boolean }> {
  const kinds = await (deps.classifyPages ?? classifyWithPdfjs)(buffer).catch((error: Error) => {
    logger.warn(`[kb/ingest] could not classify ${version.filename}: ${error.message}`);
    return [] as PageKind[];
  });
  const garbled = new Set(kinds.flatMap((kind, i) => (kind === 'garbled' ? [i + 1] : [])));
  const kept = parsed.elements.filter((element) => !garbled.has(firstPageOf(element)));
  const pageCount = Math.max(parsed.pageCount, kinds.length);
  const candidates = [
    ...new Set([...unreadablePages({ elements: kept, pageCount }), ...garbled]),
  ].sort((a, b) => a - b);
  if (candidates.length === 0) {
    return { parsed: { elements: kept, pageCount }, ocrUsed: false, ocrOff: false };
  }
  const ocr = deps.ocr;
  if (!ocr || !(await ocr.allowed(job.tenantId))) {
    return { parsed: { elements: kept, pageCount }, ocrUsed: false, ocrOff: !!ocr };
  }
  const pages = candidates.slice(0, ocr.maxPages);
  const { elements, pagesRead } = await readPdfPagesWithOcr(ocr, buffer, pages, version.filename);
  if (pagesRead.length > 0) {
    await ocr.recordCharge({
      tenantId: job.tenantId,
      documentId,
      version: job.version,
      userId: version.uploadedBy != null ? String(version.uploadedBy) : null,
      pages: pagesRead.length,
      contentHash: version.sha256,
    });
  }
  logger.info(
    `[kb/ingest] ${job.tenantId}/${documentId} v${job.version}: OCR read ${pagesRead.length} of ${candidates.length} scanned or garbled pages`,
  );
  const merged = [...kept, ...elements].sort((a, b) => firstPageOf(a) - firstPageOf(b));
  return { parsed: { elements: merged, pageCount }, ocrUsed: true, ocrOff: false };
}

/** Claims and runs one job. Returns false when the queue is empty. */
export async function processNextKbJob(deps: KbIngestDeps): Promise<boolean> {
  const job = await deps.runAsSystem(() => deps.methods.claimKbIngestJob());
  if (!job) {
    return false;
  }
  await deps.runAsTenant(job.tenantId, async () => {
    try {
      await runJob(job, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !(error instanceof KbJobRejected || error instanceof DoclingRejectedError);
      const { retrying } = await deps.methods.failKbIngestJob({
        jobId: job._id,
        error: message,
        retryable,
      });
      logger.warn(
        `[kb/ingest] ${job.tenantId}/${String(job.documentId)} v${job.version} failed${retrying ? ', will retry' : ''}: ${message}`,
      );
    }
  });
  return true;
}

/** Polls for jobs one at a time; Docling is the bottleneck, and it queues its own work. */
export function startKbIngestWorker(
  deps: KbIngestDeps,
  pollMs: number = DEFAULT_POLL_MS,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      while (!stopped && (await processNextKbJob(deps))) {
        /* drain the queue */
      }
    } catch (error) {
      logger.error('[kb/ingest] worker error', error);
    }
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
    }
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
