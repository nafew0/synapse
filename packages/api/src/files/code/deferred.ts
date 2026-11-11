import { logger } from '@librechat/data-schemas';
import type { CodeEnvFile } from '@librechat/agents';
import type { TFile } from 'librechat-data-provider';

/** Copies one file into the sandbox; `bytes`, when the caller already holds them, saves a download. */
export type CodeFileUpload = (file: TFile, bytes?: Buffer) => Promise<CodeEnvFile>;

interface DeferredFiles {
  files: Map<string, TFile>;
  upload: CodeFileUpload;
  copies: Map<string, Promise<CodeEnvFile | null>>;
}

/**
 * Attached images a model can see wait here, per request, until something needs them in the
 * sandbox: a code call, or read_document rebuilding the page. A question about the picture never
 * pays for the copy. Keyed by the request object, so the entry goes away with it.
 */
const deferredByRequest = new WeakMap<object, DeferredFiles>();

/** Images are deferred only when the model sees them itself; other files are copied at upload. */
export const isDeferredCodeFile = (file: Pick<TFile, 'type' | 'width' | 'height'>): boolean =>
  file.type?.startsWith('image/') === true && !!file.width && !!file.height;

export function deferCodeFiles(request: object, files: TFile[], upload: CodeFileUpload): void {
  if (files.length === 0) {
    return;
  }
  const entry = deferredByRequest.get(request) ?? {
    files: new Map<string, TFile>(),
    upload,
    copies: new Map<string, Promise<CodeEnvFile | null>>(),
  };
  entry.upload = upload;
  for (const file of files) {
    entry.files.set(file.file_id, file);
  }
  deferredByRequest.set(request, entry);
}

export const hasDeferredCodeFiles = (request: object): boolean =>
  (deferredByRequest.get(request)?.files.size ?? 0) > 0;

function copyOnce(entry: DeferredFiles, file: TFile, bytes?: Buffer): Promise<CodeEnvFile | null> {
  const started = entry.copies.get(file.file_id);
  if (started) {
    return started;
  }
  const copy = entry.upload(file, bytes).catch((error: unknown) => {
    logger.warn(`[deferredCodeFiles] Could not copy "${file.filename}" to the sandbox:`, error);
    entry.copies.delete(file.file_id);
    return null;
  });
  entry.copies.set(file.file_id, copy);
  return copy;
}

/** Copies every deferred file of this request into the sandbox, each at most once. */
export async function bringDeferredCodeFiles(request: object): Promise<CodeEnvFile[]> {
  const entry = deferredByRequest.get(request);
  if (!entry) {
    return [];
  }
  const copies = await Promise.all([...entry.files.values()].map((file) => copyOnce(entry, file)));
  return copies.filter((copy): copy is CodeEnvFile => copy != null);
}

/**
 * The sandbox copy of one file, made now if it is still deferred. Returns null when the file was
 * never deferred for this request, so the caller can copy it its own way.
 */
export function bringDeferredCodeFile(
  request: object,
  file: Pick<TFile, 'file_id'>,
  bytes?: Buffer,
): Promise<CodeEnvFile | null> | null {
  const entry = deferredByRequest.get(request);
  const deferred = entry?.files.get(file.file_id);
  if (!entry || !deferred) {
    return null;
  }
  return copyOnce(entry, deferred, bytes);
}
