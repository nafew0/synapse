import FormData from 'form-data';
import { logger } from '@librechat/data-schemas';
import type { DoclingConvertResult, DoclingDocument } from './types';
import { createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();

const POLL_WAIT_SECONDS = 10;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING = new Set(['pending', 'started']);

export interface DoclingClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface DoclingFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
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

/**
 * Converts one file with docling-serve's async API: submit, long-poll, fetch. OCR stays off:
 * scanned pages are read by the hybrid OCR path, and Docling's own OCR is weak on Bangla.
 */
export function createDoclingClient(options: DoclingClientOptions): DoclingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = { 'X-Api-Key': options.apiKey };

  const submit = async (file: DoclingFile): Promise<TaskStatus> => {
    const form = new FormData();
    form.append('files', file.buffer, { filename: file.filename, contentType: file.mimeType });
    form.append('do_ocr', 'false');
    form.append('table_mode', 'accurate');
    form.append('to_formats', 'json');
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
      const { data } = await axios.get<TaskStatus>(`${base}/v1/status/poll/${taskId}`, {
        headers,
        params: { wait: POLL_WAIT_SECONDS },
        timeout: (POLL_WAIT_SECONDS + 30) * 1000,
      });
      if (!PENDING.has(data.task_status)) {
        return data.task_status;
      }
    }
    throw new Error(`Docling task ${taskId} timed out after ${timeoutMs} ms`);
  };

  const convert = async (file: DoclingFile): Promise<DoclingDocument> => {
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
    logger.info(
      `[kb/docling] ${file.filename}: ${document.texts.length} texts, ${document.tables.length} tables in ${Date.now() - started} ms`,
    );
    return document;
  };

  return { convert };
}
