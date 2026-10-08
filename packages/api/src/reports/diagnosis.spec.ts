import type { TErrorSummary } from '~/errors/public';
import { diagnose, mergeSummaries } from './diagnosis';

const REQUEST_ID = '0909ce58-a757-43a8-a7d2-cf0f99d5775f';
const CODE_API = 'https://code.example.test/v1';

/** The two log entries a code-API upload failure produces today. */
const uploadFailure: TErrorSummary[] = [
  {
    requestId: REQUEST_ID,
    code: 'not_found',
    status: 404,
    message:
      'Error uploading code environment file: Request failed with status code 404 The server responded with status 404: Request failed with status code 404',
    upstream: {
      status: 404,
      method: 'POST',
      url: `${CODE_API}/upload`,
      body: '{"error":"Not found"}',
    },
    route: '/api/files',
    at: '2026-10-08T18:56:35.564Z',
  },
  {
    requestId: REQUEST_ID,
    code: 'unknown',
    message:
      '[/files] Error processing file: Error uploading code environment file: Request failed with status code 404 The server responded with status 404: Request failed with status code 404',
    frames: [
      'uploadCodeEnvFile (api/server/services/Files/Code/crud.js:207:11)',
      'async uploadToCodeEnvironment (api/server/services/Files/process.js:716:20)',
    ],
    route: '/api/files',
    at: '2026-10-08T18:56:35.565Z',
  },
];

describe('mergeSummaries', () => {
  it('collapses the same failure logged at two layers into one entry', () => {
    const [merged, ...rest] = mergeSummaries(uploadFailure);
    expect(rest).toHaveLength(0);
    expect(merged.message).toContain('[/files] Error processing file');
    expect(merged.upstream?.url).toBe(`${CODE_API}/upload`);
    expect(merged.frames).toHaveLength(2);
  });

  it('keeps unrelated failures separate', () => {
    const other: TErrorSummary = { ...uploadFailure[0], message: 'connect ECONNREFUSED' };
    expect(mergeSummaries([uploadFailure[0], other])).toHaveLength(2);
  });
});

describe('diagnose', () => {
  const original = process.env.LIBRECHAT_CODE_BASEURL;

  afterEach(() => {
    process.env.LIBRECHAT_CODE_BASEURL = original;
  });

  it('names the service, the failed call, our code location and the likely cause', () => {
    process.env.LIBRECHAT_CODE_BASEURL = `${CODE_API}/`;
    const diagnosis = diagnose(mergeSummaries(uploadFailure));
    expect(diagnosis).toEqual({
      failed: 'File upload (/api/files)',
      serviceLabel: 'Code API',
      service: 'Code interpreter (Code API)',
      upstreamCall: `404 · POST · ${CODE_API}/upload`,
      upstreamReply: '{"error":"Not found"}',
      location: [
        'uploadCodeEnvFile (api/server/services/Files/Code/crud.js:207:11)',
        'async uploadToCodeEnvironment (api/server/services/Files/process.js:716:20)',
      ],
      cause: expect.stringContaining('"not found"'),
    });
  });

  it('falls back to the message to name the service and spots unreachable services', () => {
    delete process.env.LIBRECHAT_CODE_BASEURL;
    const diagnosis = diagnose([
      {
        requestId: REQUEST_ID,
        code: 'service_unavailable',
        message: 'Error uploading code environment file: connect ECONNREFUSED 10.0.0.5:8000',
        at: '2026-10-08T18:56:35.564Z',
      },
    ]);
    expect(diagnosis?.serviceLabel).toBe('Code API');
    expect(diagnosis?.cause).toContain('could not reach the service');
  });

  it('returns nothing without summaries', () => {
    expect(diagnose([])).toBeUndefined();
  });
});
