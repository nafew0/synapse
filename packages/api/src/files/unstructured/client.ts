import FormData from 'form-data';
import { logger } from '@librechat/data-schemas';
import type { AxiosError, AxiosRequestConfig } from 'axios';
import type { PartitionFile, UnstructuredClientOptions, UnstructuredElement } from './types';
import { createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MIN_MS = 2_000;
const DEFAULT_POLL_MAX_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;
/** How long the first request waits for a result before the job is followed by polling. */
const INITIAL_WAIT_SECONDS = 120;
const POLL_REQUEST_TIMEOUT_MS = 60 * 1000;

interface ParseResult {
  id?: string;
  status?: string;
  elements?: UnstructuredElement[];
  warnings?: { code: string; message: string }[];
  poll_url?: string;
}

/** Job retrieval wraps the document; the first response is the document itself. */
interface JobResult extends ParseResult {
  result?: ParseResult | null;
  error?: unknown;
}

const PENDING_STATUSES = new Set(['queued', 'processing']);
const FAILED_STATUSES = new Set(['failed', 'cancelled']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs at most `limit` tasks at once; the rest wait their turn. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const waiting: Array<() => void> = [];
  let running = 0;
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

const isRetryable = (error: unknown): boolean => {
  const status = (error as AxiosError)?.response?.status;
  return status === 429 || (status != null && status >= 500);
};

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryable(error)) {
        throw error;
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

export interface UnstructuredClient {
  /** Sends one file through Parse and returns its elements. */
  partition: (file: PartitionFile) => Promise<UnstructuredElement[]>;
}

/**
 * Calls Unstructured's Parse API. The `best` profile read Bangla and Sinhala correctly in our
 * benchmark, where a Jobs API VLM node silently fell back to a Latin-only OCR while reporting success.
 */
export function createUnstructuredClient(options: UnstructuredClientOptions): UnstructuredClient {
  const {
    apiUrl,
    apiKey,
    profile,
    concurrency,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMinMs = DEFAULT_POLL_MIN_MS,
    pollMaxMs = DEFAULT_POLL_MAX_MS,
  } = options;
  const base = apiUrl.replace(/\/+$/, '');
  const limit = createLimiter(concurrency);
  const auth: AxiosRequestConfig = { headers: { 'unstructured-api-key': apiKey } };

  const resolvePollUrl = (reference: string): string =>
    /^https?:\/\//.test(reference) ? reference : `${base}${reference}`;

  const cancel = async (jobId?: string): Promise<void> => {
    if (!jobId) {
      return;
    }
    await axios
      .post(`${base}/api/v2/jobs/${jobId}/cancel`, undefined, {
        ...auth,
        timeout: POLL_REQUEST_TIMEOUT_MS,
      })
      .catch((error) => {
        logger.warn(`[unstructured] could not cancel job ${jobId}: ${error?.message}`);
      });
  };

  const follow = async (pollUrl: string, jobId?: string): Promise<ParseResult> => {
    const deadline = Date.now() + timeoutMs;
    let delay = pollMinMs;
    while (Date.now() < deadline) {
      await sleep(delay);
      const { data } = await withRetry(() =>
        axios.get<JobResult>(pollUrl, { ...auth, timeout: POLL_REQUEST_TIMEOUT_MS }),
      );
      const status = data.status ?? data.result?.status;
      if (status && FAILED_STATUSES.has(status)) {
        throw new Error(`Unstructured job ${jobId ?? pollUrl} ended ${status}`);
      }
      if (status && !PENDING_STATUSES.has(status)) {
        return data.result ?? data;
      }
      delay = Math.min(delay * 1.5, pollMaxMs);
    }
    await cancel(jobId);
    throw new Error(`Unstructured job ${jobId ?? pollUrl} timed out after ${timeoutMs} ms`);
  };

  const partition = (file: PartitionFile): Promise<UnstructuredElement[]> =>
    limit(async () => {
      const started = Date.now();
      const response = await withRetry(() => {
        const form = new FormData();
        form.append('output', 'elements');
        form.append('profile', profile);
        form.append('input', file.buffer, { filename: file.filename, contentType: file.type });
        return axios.post<ParseResult>(
          `${base}/api/v2/parse?include=coordinates&include=table_html`,
          form,
          {
            ...auth,
            headers: {
              ...auth.headers,
              ...form.getHeaders(),
              Prefer: `wait=${INITIAL_WAIT_SECONDS}`,
            },
            maxBodyLength: Infinity,
            timeout: (INITIAL_WAIT_SECONDS + 30) * 1000,
          },
        );
      });

      let result = response.data;
      if (response.status === 202) {
        const reference = response.headers?.location ?? result.poll_url;
        if (!reference) {
          throw new Error('Unstructured accepted the document but named nowhere to follow it');
        }
        result = await follow(resolvePollUrl(reference), result.id);
      }
      if (!Array.isArray(result.elements)) {
        throw new Error(`Unstructured job ${result.id} returned no elements`);
      }
      result.warnings?.forEach(({ code }) =>
        logger.warn(`[unstructured] job ${result.id}: ${code}`),
      );
      logger.info(
        `[unstructured] job ${result.id}: ${result.elements.length} elements in ${Date.now() - started} ms`,
      );
      return result.elements;
    });

  return { partition };
}
