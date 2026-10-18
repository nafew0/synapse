import { CONNECTION_ERROR_TEXT, toErrorText } from '../errors';

const requestId = 'req-123';

describe('toErrorText', () => {
  it('unwraps the job error JSON from an SSE error event', () => {
    const event = { error: JSON.stringify({ type: 'service_busy', requestId, info: 'gpt-x' }) };
    expect(JSON.parse(toErrorText(event))).toEqual({ type: 'service_busy', requestId });
  });

  it('keeps only code and request id from an HTTP error body', () => {
    const body = { code: 'context_too_long', requestId, message: 'org-abc gpt-x' };
    expect(JSON.parse(toErrorText(body))).toEqual({ type: 'context_too_long', requestId });
  });

  it('reads the code and request id header from an axios-like error', () => {
    const error = {
      response: {
        status: 503,
        data: 'Bad gateway org-abc',
        headers: { 'x-request-id': requestId },
      },
    };
    expect(JSON.parse(toErrorText(error))).toEqual({ type: 'service_unavailable', requestId });
  });

  it.each([
    ['legacy raw text', 'An error occurred: 429 Rate limit for gpt-x in org-abc'],
    ['an SSE error with raw text', { error: '429 Rate limit for gpt-x in org-abc' }],
    ['an SSE error with a text field', { text: 'No model spec selected for gpt-x' }],
    ['a thrown error', new Error('connect ECONNREFUSED 10.0.0.1:8000 org-abc')],
    ['nothing', undefined],
  ])('turns %s into the unknown code', (_label, payload) => {
    const text = toErrorText(payload);
    expect(JSON.parse(text)).toEqual({ type: 'unknown' });
    expect(text).not.toMatch(/org-abc|gpt-x/);
  });

  it('uses a code, not English text, for lost connections', () => {
    expect(JSON.parse(CONNECTION_ERROR_TEXT)).toEqual({ type: 'connection_lost' });
  });
});

describe('toErrorText for usage-limit refusals', () => {
  const envelope = JSON.stringify({
    type: 'token_quota_exceeded',
    limitCode: 'WEEKLY_CAP',
    window: 'week',
    meter: 'credits',
    resetAt: '2026-10-19T00:00:00.000Z',
    requestId: 'dc36ad9d-8942-4322-bb9f-c65bc15354ac',
  });

  it('keeps the wall and its reset from an SSE error event', () => {
    expect(JSON.parse(toErrorText({ error: envelope }))).toEqual({
      type: 'token_quota_exceeded',
      limitCode: 'WEEKLY_CAP',
      window: 'week',
      meter: 'credits',
      resetAt: '2026-10-19T00:00:00.000Z',
      requestId: 'dc36ad9d-8942-4322-bb9f-c65bc15354ac',
    });
  });

  it('keeps nothing else, and nothing extra for other errors', () => {
    const leaky = JSON.stringify({ type: 'token_quota_exceeded', limit: 1422, used: 1432 });
    expect(JSON.parse(toErrorText({ error: leaky }))).toEqual({ type: 'token_quota_exceeded' });
    const other = JSON.stringify({ type: 'no_user_key', limitCode: 'WEEKLY_CAP' });
    expect(JSON.parse(toErrorText({ error: other }))).toEqual({ type: 'no_user_key' });
  });
});
