/** Called with the share of the request body sent so far, from 0 to 1. */
export type UploadProgressCallback = (fraction: number) => void;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const parseHeaders = (raw: string): Headers => {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(':');
    if (index > 0) {
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  return headers;
};

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * A `fetch` stand-in built on XMLHttpRequest, because `fetch` cannot report how much of a request
 * body has been sent. It resolves once the response headers arrive and streams the body as it
 * comes in, so callers that read a server-sent event stream keep working unchanged.
 */
export const xhrFetch = (
  url: string,
  init: RequestInit = {},
  onUploadProgress?: UploadProgressCallback,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const { signal } = init;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let sent = 0;

    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        xhr.abort();
      },
    });

    const flush = () => {
      const text = xhr.responseText;
      if (text.length > sent) {
        controller?.enqueue(encoder.encode(text.slice(sent)));
        sent = text.length;
      }
    };

    const fail = (error: Error) => {
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(error);
        return;
      }
      controller?.error(error);
    };

    const onAbort = () => xhr.abort();

    xhr.open(init.method ?? 'GET', url);
    xhr.withCredentials = init.credentials === 'include';
    new Headers(init.headers).forEach((value, key) => xhr.setRequestHeader(key, value));

    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onUploadProgress(event.loaded / event.total);
        }
      };
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED || settled) {
        return;
      }
      settled = true;
      resolve(
        new Response(NULL_BODY_STATUSES.has(xhr.status) ? null : body, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseHeaders(xhr.getAllResponseHeaders()),
        }),
      );
    };
    xhr.onprogress = flush;
    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      flush();
      controller?.close();
    };
    xhr.onerror = () => fail(new TypeError('Network request failed'));
    xhr.ontimeout = () => fail(new TypeError('Network request timed out'));
    xhr.onabort = () => fail(abortError());

    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send((init.body as XMLHttpRequestBodyInit | null | undefined) ?? null);
  });
