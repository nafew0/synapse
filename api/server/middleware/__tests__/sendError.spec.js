const { logger } = require('@librechat/data-schemas');
const { ErrorTypes, ViolationTypes } = require('librechat-data-provider');

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  getConvo: jest.fn(),
}));

const { toSafeErrorText, sendError } = require('~/server/middleware/error');

const req = { requestId: 'req-send-1', user: { id: 'user-1' }, body: {} };

function createSseResponse() {
  return {
    headersSent: true,
    writableEnded: false,
    write: jest.fn(),
    end: jest.fn(),
    flush: jest.fn(),
  };
}

describe('toSafeErrorText', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('classifies raw error text, logs it once and never returns it', () => {
    const raw = '429 Rate limit reached for gpt-x in organization org-abc (http://rag_api:8000)';
    const text = toSafeErrorText(req, raw, 'convo-1');

    expect(JSON.parse(text)).toEqual({ type: 'service_busy', requestId: 'req-send-1' });
    expect(text).not.toContain('gpt-x');
    expect(text).not.toContain('org-abc');
    expect(text).not.toContain('rag_api');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps violation payloads the client renders but drops their raw error text', () => {
    const text = toSafeErrorText(
      req,
      JSON.stringify({
        type: ViolationTypes.CONVO_ACCESS,
        error: 'User not authorized for this conversation',
      }),
    );
    expect(JSON.parse(text)).toEqual({
      type: ViolationTypes.CONVO_ACCESS,
      requestId: 'req-send-1',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps message_limit details', () => {
    const text = toSafeErrorText(
      req,
      JSON.stringify({
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        limiter: 'user',
        windowInMinutes: 1,
      }),
    );
    expect(JSON.parse(text)).toEqual({
      type: ViolationTypes.MESSAGE_LIMIT,
      max: 40,
      limiter: 'user',
      windowInMinutes: 1,
      requestId: 'req-send-1',
    });
  });

  it('passes an already-public code through without logging again', () => {
    const text = toSafeErrorText(
      req,
      JSON.stringify({ type: 'connection_lost', requestId: 'req-original' }),
    );
    expect(JSON.parse(text)).toEqual({ type: 'connection_lost', requestId: 'req-original' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps typed error codes such as invalid_request_error', () => {
    const text = toSafeErrorText(req, JSON.stringify({ type: ErrorTypes.INVALID_REQUEST }));
    expect(JSON.parse(text)).toEqual({ type: ErrorTypes.INVALID_REQUEST, requestId: 'req-send-1' });
  });
});

describe('sendError', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('streams only a typed error code, never the raw message', async () => {
    const res = createSseResponse();
    await sendError(req, res, {
      sender: 'AI',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      text: 'error in moderation check: http://moderation.internal/v1',
    });

    const written = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(written).not.toContain('moderation.internal');
    expect(written).toContain('\\"type\\":\\"unknown\\"');
    expect(written).toContain('req-send-1');
  });

  it('leaves partial (unfinished) response text untouched', async () => {
    const res = createSseResponse();
    await sendError(req, res, {
      sender: 'AI',
      conversationId: 'convo-1',
      parentMessageId: 'parent-1',
      text: 'partial answer',
      error: false,
      unfinished: true,
    });
    const written = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(written).toContain('partial answer');
  });
});
