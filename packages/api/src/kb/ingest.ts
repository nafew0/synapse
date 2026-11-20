import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { IKbIngestJob, KbMethods } from '@librechat/data-schemas';
import type { KbChunk, KbElement, KbParsed } from './types';
import type { PageKind } from '~/files/scan/classify';
import type { KbIndexClient } from './rag';
import type { KbOcrReader } from './ocr';
import { DoclingRejectedError, type DoclingClient, type DoclingFile } from './docling';
import { forgetInstitutionKb } from './availability';
import { readPdfPagesWithOcr } from './ocr';
import { chunkElements } from './chunk';
import { toElements } from './elements';
import { cleanText } from './normalize';

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
const DEFAULT_RECONCILE_MS = 30 * 60 * 1000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SLICE_PAGES = 50;
/** Well inside the job lease, so a long document is never reclaimed while it runs. */
const LEASE_RENEW_MS = 5 * 60 * 1000;
const PDF = 'application/pdf';

export interface KbIngestDeps {
  methods: Pick<
    KbMethods,
    | 'claimKbIngestJob'
    | 'renewKbIngestJob'
    | 'completeKbIngestJob'
    | 'failKbIngestJob'
    | 'getKbDocument'
    | 'getKbDocumentVersion'
    | 'updateKbDocument'
    | 'listKbDocumentIds'
    | 'listKbTenantIds'
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
  /** PDFs longer than this go to Docling in page ranges of this size. */
  pdfSlicePages?: number;
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

/** 1-based page ranges of at most `size` pages; one range or none when no split is needed. */
export function pageRanges(pageCount: number, size: number): [number, number][] {
  if (pageCount <= size) {
    return [];
  }
  return Array.from({ length: Math.ceil(pageCount / size) }, (_, i): [number, number] => [
    i * size + 1,
    Math.min((i + 1) * size, pageCount),
  ]);
}

/**
 * Converts a long PDF in page ranges: each range is a smaller Docling task, so ranges convert
 * side by side, use less memory, and stay well inside Docling's time limit. Page numbers in
 * each range's result are the file's own, so the ranges join in order.
 */
async function convertWithDocling(
  deps: KbIngestDeps,
  file: DoclingFile,
  pageCount: number,
): Promise<KbParsed> {
  const ranges = pageRanges(pageCount, deps.pdfSlicePages ?? DEFAULT_SLICE_PAGES);
  if (ranges.length === 0) {
    return toElements(await deps.docling.convert(file));
  }
  const slices = await Promise.all(
    ranges.map((pageRange) =>
      deps.docling.convert({ ...file, pageRange }).then((document) => toElements(document)),
    ),
  );
  return {
    elements: slices.flatMap((slice) => slice.elements),
    pageCount: Math.max(pageCount, ...slices.map((slice) => slice.pageCount)),
  };
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
  const isPdf = version.mimeType === PDF;
  const kinds = isPdf ? await classifyPages(deps, buffer, version.filename) : [];
  let parsed =
    version.mimeType === 'text/plain'
      ? parsePlainText(buffer)
      : await convertWithDocling(
          deps,
          { buffer, filename: version.filename, mimeType: version.mimeType },
          kinds.length,
        );
  let ocrUsed = false;
  let ocrOff = false;
  if (isPdf) {
    const result = await readScannedPages({
      deps,
      job,
      parsed,
      kinds,
      buffer,
      version,
      documentId,
    });
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
  /* Deleted while being processed: the admin's delete may have reached the index before this
   * version was activated, so this worker removes what it just made searchable. */
  if (!(await deps.methods.getKbDocument(documentId))) {
    await deps.index.remove({ tenantId: job.tenantId, documentId });
    forgetInstitutionKb(job.tenantId);
    logger.info(`[kb/ingest] ${job.tenantId}/${documentId} was deleted while processing; removed`);
    return;
  }
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

/** Page kinds, which also give the page count; empty when the PDF cannot be read here. */
function classifyPages(deps: KbIngestDeps, buffer: Buffer, filename: string): Promise<PageKind[]> {
  return (deps.classifyPages ?? classifyWithPdfjs)(buffer).catch((error: Error) => {
    logger.warn(`[kb/ingest] could not classify ${filename}: ${error.message}`);
    return [] as PageKind[];
  });
}

/**
 * Sends a PDF's scanned pages, and pages whose text layer is garbled (old Bangla encodings),
 * to OCR when the institution may use it. Garbled text is never indexed, read or not.
 */
async function readScannedPages({
  deps,
  job,
  parsed,
  kinds,
  buffer,
  version,
  documentId,
}: {
  deps: KbIngestDeps;
  job: IKbIngestJob;
  parsed: KbParsed;
  kinds: PageKind[];
  buffer: Buffer;
  version: { filename: string; sha256: string; uploadedBy?: unknown };
  documentId: string;
}): Promise<{ parsed: KbParsed; ocrUsed: boolean; ocrOff: boolean }> {
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

/**
 * Removes index chunks whose document no longer has a record: a delete that could not reach
 * the index, a crash between steps, or a manual edit. Returns how many documents it removed.
 */
export async function reconcileKbIndex(deps: KbIngestDeps): Promise<number> {
  const tenants = await deps.runAsSystem(() => deps.methods.listKbTenantIds());
  let removed = 0;
  for (const tenantId of tenants) {
    const indexed = await deps.index.listDocumentIds(tenantId);
    if (indexed.length === 0) {
      continue;
    }
    const known = new Set(
      await deps.runAsTenant(tenantId, () => deps.methods.listKbDocumentIds(tenantId)),
    );
    for (const documentId of indexed.filter((id) => !known.has(id))) {
      await deps.index.remove({ tenantId, documentId });
      removed++;
      logger.warn(
        `[kb/reconcile] removed index chunks of deleted document ${tenantId}/${documentId}`,
      );
    }
  }
  return removed;
}

/** Claims and runs one job. Returns false when the queue is empty. */
export async function processNextKbJob(deps: KbIngestDeps): Promise<boolean> {
  const job = await deps.runAsSystem(() => deps.methods.claimKbIngestJob());
  if (!job) {
    return false;
  }
  const renew = setInterval(() => {
    deps
      .runAsSystem(() => deps.methods.renewKbIngestJob(job._id))
      .catch((error: Error) =>
        logger.warn(`[kb/ingest] could not renew job lease: ${error.message}`),
      );
  }, LEASE_RENEW_MS);
  renew.unref();
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
    } finally {
      clearInterval(renew);
    }
  });
  return true;
}

export interface KbIngestWorkerOptions {
  pollMs?: number;
  reconcileMs?: number;
  /** Jobs run at once. Docling's own limit decides how many convert at the same moment. */
  concurrency?: number;
}

/**
 * Polls for jobs and runs up to `concurrency` at once, each lane draining the queue. Claims
 * are atomic, so lanes, and other server processes, never take the same job.
 */
export function startKbIngestWorker(
  deps: KbIngestDeps,
  {
    pollMs = DEFAULT_POLL_MS,
    reconcileMs = DEFAULT_RECONCILE_MS,
    concurrency = DEFAULT_CONCURRENCY,
  }: KbIngestWorkerOptions = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let nextReconcile = 0;
  const lane = async (): Promise<void> => {
    try {
      while (!stopped && (await processNextKbJob(deps))) {
        /* drain the queue */
      }
    } catch (error) {
      logger.error('[kb/ingest] worker error', error);
    }
  };
  const tick = async () => {
    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
      if (!stopped && Date.now() >= nextReconcile) {
        nextReconcile = Date.now() + reconcileMs;
        await reconcileKbIndex(deps);
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
