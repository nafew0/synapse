import FormData from 'form-data';
import { logger } from '@librechat/data-schemas';
import type { DoclingConvertResult, DoclingDocument } from './types';
import { createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();

const POLL_WAIT_SECONDS = 10;
/** docling-serve 1.38.2 answers a poll at once, ignoring `wait`; without a gap the loop spins. */
const MIN_POLL_GAP_MS = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING = new Set(['pending', 'started']);
const DEFAULT_MAX_CONCURRENT = 2;

export interface DoclingClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Shortest time between two status polls of one task. */
  minPollGapMs?: number;
  /** Conversions this process runs at once; match docling-serve's `ENG_LOC_NUM_WORKERS`. */
  maxConcurrent?: number;
}

export interface DoclingFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  /** First and last 1-based page to convert. Page numbers in the result stay the file's own. */
  pageRange?: [number, number];
}

export interface DoclingClient {
  convert(file: DoclingFile): Promise<DoclingDocument>;
}

/** A failure that retrying the same file will not fix. */
export class DoclingRejectedError extends Error {}

interface TaskStatus {
  task_id: string;
  task_status: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs at most `limit` tasks at once, the rest in arrival order. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    active--;
    waiting.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Converts one file with docling-serve's async API: submit, long-poll, fetch. OCR stays off:
 * scanned pages are read by the hybrid OCR path, and Docling's own OCR is weak on Bangla.
 * Picture crops are not generated: ingestion reads text and tables only, and on CPU the crops
 * cost time and memory. Conversions queue here rather than in Docling, so a task's timeout
 * counts from when Docling starts on it.
 */
export function createDoclingClient(options: DoclingClientOptions): DoclingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollGapMs = options.minPollGapMs ?? MIN_POLL_GAP_MS;
  const headers = { 'X-Api-Key': options.apiKey };
  const limit = createLimiter(Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));

  const submit = async (file: DoclingFile): Promise<TaskStatus> => {
    const form = new FormData();
    form.append('files', file.buffer, { filename: file.filename, contentType: file.mimeType });
    form.append('do_ocr', 'false');
    form.append('table_mode', 'accurate');
    form.append('to_formats', 'json');
    form.append('include_images', 'false');
    form.append('image_export_mode', 'placeholder');
    if (file.pageRange) {
      form.append('page_range', String(file.pageRange[0]));
      form.append('page_range', String(file.pageRange[1]));
    }
    const { data } = await axios.post<TaskStatus>(`${base}/v1/convert/file/async`, form, {
      headers: { ...headers, ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return data;
  };

  const waitFor = async (taskId: string): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const asked = Date.now();
      const { data } = await axios.get<TaskStatus>(`${base}/v1/status/poll/${taskId}`, {
        headers,
        params: { wait: POLL_WAIT_SECONDS },
        timeout: (POLL_WAIT_SECONDS + 30) * 1000,
      });
      if (!PENDING.has(data.task_status)) {
        return data.task_status;
      }
      await sleep(Math.max(0, asked + pollGapMs - Date.now()));
    }
    throw new Error(`Docling task ${taskId} timed out after ${timeoutMs} ms`);
  };

  const run = async (file: DoclingFile): Promise<DoclingDocument> => {
    const started = Date.now();
    const task = await submit(file);
    const status = await waitFor(task.task_id);
    const { data } = await axios.get<DoclingConvertResult>(`${base}/v1/result/${task.task_id}`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const document = data.document?.json_content;
    if (status !== 'success' || !document) {
      const reason =
        data.errors?.map((error) => error.error_message).join('; ') || `status ${status}`;
      throw new DoclingRejectedError(`Docling could not convert ${file.filename}: ${reason}`);
    }
    const pages = file.pageRange ? ` pages ${file.pageRange[0]}-${file.pageRange[1]}` : '';
    logger.info(
      `[kb/docling] ${file.filename}${pages}: ${document.texts.length} texts, ${document.tables.length} tables in ${Date.now() - started} ms`,
    );
    return document;
  };

  const convert = (file: DoclingFile): Promise<DoclingDocument> => limit(() => run(file));

  return { convert };
}
