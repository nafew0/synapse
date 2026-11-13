import { logger } from '@librechat/data-schemas';
import type { IKbIngestJob, KbMethods } from '@librechat/data-schemas';
import type { KbIndexClient } from './rag';
import type { KbChunk, KbParsed } from './types';
import { DoclingRejectedError, type DoclingClient } from './docling';
import { forgetInstitutionKb } from './availability';
import { chunkElements } from './chunk';
import { toElements } from './elements';
import { cleanText } from './normalize';

export const KB_PARSER = { name: 'docling-serve', version: '1.38.2' } as const;

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
  >;
  docling: DoclingClient;
  index: KbIndexClient;
  readFile(fileRef: string): Promise<Buffer>;
  deleteFile(fileRef: string): Promise<void>;
  runAsSystem<T>(fn: () => Promise<T>): Promise<T>;
  runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

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
    const pages = element.kind === 'table' ? [element.pageStart, element.pageEnd] : [element.page];
    pages.forEach((page) => page != null && read.add(page));
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
  const parsed =
    version.mimeType === 'text/plain'
      ? parsePlainText(buffer)
      : toElements(
          await deps.docling.convert({
            buffer,
            filename: version.filename,
            mimeType: version.mimeType,
          }),
        );
  const chunks: KbChunk[] = chunkElements(document.title, parsed.elements);
  const unreadable = unreadablePages(parsed);
  if (chunks.length === 0) {
    throw new KbJobRejected(
      unreadable.length > 0
        ? 'No readable text: the file looks scanned, and scanned pages are not read yet'
        : 'No readable text in this file',
    );
  }

  const target = { tenantId: job.tenantId, documentId, version: job.version };
  await deps.index.upload({ ...target, title: document.title, docType: document.docType, chunks });
  await deps.index.activate(target);
  const { prunedFileRefs } = await deps.methods.completeKbIngestJob({
    jobId: job._id,
    pageCount: parsed.pageCount,
    chunkCount: chunks.length,
    unreadablePages: unreadable,
    parser: KB_PARSER,
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
