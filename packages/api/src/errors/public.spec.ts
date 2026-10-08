import OpenAI from 'openai';
import { AxiosError } from 'axios';
import { logger, tenantStorage, setErrorLogHook } from '@librechat/data-schemas';
import { ErrorTypes, ViolationTypes, PublicErrorCodes } from 'librechat-data-provider';
import type { TErrorSummary } from './public';
import {
  toChatError,
  toPublicError,
  getErrorSummaries,
  captureLoggedErrors,
  toChatErrorText,
  toPublicErrorBody,
} from './public';

const PROVIDER_MESSAGE = '429 Rate limit reached for gpt-x in organization org-abc';
const SECRETS = ['gpt-x', 'org-abc', 'rag_api', 'http://', '8000'];

function rateLimitError(): InstanceType<typeof OpenAI.APIError> {
  return OpenAI.APIError.generate(
    429,
    { error: { message: 'Rate limit reached for gpt-x in organization org-abc', code: null } },
    undefined,
    new Headers(),
  );
}

function expectNoSecrets(output: string): void {
  for (const secret of SECRETS) {
    expect(output).not.toContain(secret);
  }
}

async function waitForSummary(
  requestId: string,
  userId: string,
): Promise<TErrorSummary | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [summary] = await getErrorSummaries(requestId, userId);
    if (summary) {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

describe('toPublicError', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns only a code and request id for a provider error', () => {
    const result = toPublicError(rateLimitError(), {
      requestId: 'req-provider-1',
      userId: 'user-1',
      model: 'gpt-x',
      provider: 'openAI',
    });

    expect(result).toEqual({ code: PublicErrorCodes.SERVICE_BUSY, requestId: 'req-provider-1' });
    expectNoSecrets(JSON.stringify(result));
  });

  it('logs the full error exactly once with its context', () => {
    const error = rateLimitError();
    toPublicError(error, { requestId: 'req-log-1', userId: 'user-1', conversationId: 'convo-1' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toContain(PublicErrorCodes.SERVICE_BUSY);
    expect(message).toContain('req-log-1');
    expect(meta).toMatchObject({
      requestId: 'req-log-1',
      userId: 'user-1',
      conversationId: 'convo-1',
      error: { message: error.message, status: 429 },
    });
    expect(meta.error.stack).toEqual(expect.any(String));
  });

  it('does not log an abort as an error', () => {
    const result = toPublicError(new DOMException('This operation was aborted', 'AbortError'), {
      requestId: 'req-abort-1',
    });
    expect(result).toEqual({ code: PublicErrorCodes.CONNECTION_LOST, requestId: 'req-abort-1' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('takes the request id from the request context when none is passed', async () => {
    const result = await tenantStorage.run(
      { requestId: 'req-als-1', userId: 'user-als' },
      async () => toPublicError(new Error('boom')),
    );
    expect(result.requestId).toBe('req-als-1');
  });

  it('generates a request id when there is no context', () => {
    const result = toPublicError(new Error('boom'));
    expect(result.requestId).toEqual(expect.any(String));
    expect(result.requestId?.length).toBeGreaterThan(8);
  });

  it('keeps token_balance numbers but never sends generations', () => {
    const error = new Error(
      JSON.stringify({
        type: ViolationTypes.TOKEN_BALANCE,
        balance: 5,
        tokenCost: 120,
        promptTokens: 100,
        generations: [{ text: 'partial answer from gpt-x' }],
      }),
    );
    const text = toChatError(error, { requestId: 'req-balance-1' });
    expect(JSON.parse(text)).toEqual({
      type: ViolationTypes.TOKEN_BALANCE,
      balance: 5,
      tokenCost: 120,
      promptTokens: 100,
      requestId: 'req-balance-1',
    });
    expectNoSecrets(text);
  });

  it('keeps the refusal type but drops info', () => {
    const error = new Error(
      JSON.stringify({ type: ErrorTypes.REFUSAL, info: { model: 'gpt-x', org: 'org-abc' } }),
    );
    const text = toChatError(error, { requestId: 'req-refusal-1' });
    expect(JSON.parse(text)).toEqual({ type: ErrorTypes.REFUSAL, requestId: 'req-refusal-1' });
  });
});

describe('toChatError', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serializes a provider error into the JSON the chat UI parses, without raw text', () => {
    const text = toChatError(new Error(PROVIDER_MESSAGE), { requestId: 'req-chat-1' });
    expect(JSON.parse(text)).toEqual({
      type: PublicErrorCodes.SERVICE_BUSY,
      requestId: 'req-chat-1',
    });
    expectNoSecrets(text);
  });

  it('never leaks the URL from an internal service error', () => {
    const error = new AxiosError(
      'Request failed with status code 503 (http://rag_api:8000/query)',
      AxiosError.ERR_BAD_RESPONSE,
    );
    const text = toChatError(error, { requestId: 'req-axios-1' });
    expect(JSON.parse(text)).toEqual({ type: expect.any(String), requestId: 'req-axios-1' });
    expectNoSecrets(text);
  });

  it('round-trips through toChatErrorText', () => {
    expect(JSON.parse(toChatErrorText({ code: PublicErrorCodes.UNKNOWN }))).toEqual({
      type: PublicErrorCodes.UNKNOWN,
    });
  });
});

describe('toPublicErrorBody', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the fallback code only for unknown errors', () => {
    expect(
      toPublicErrorBody(new Error('boom'), { requestId: 'r1' }, PublicErrorCodes.REQUEST_FAILED),
    ).toEqual({ code: PublicErrorCodes.REQUEST_FAILED, requestId: 'r1' });
    expect(
      toPublicErrorBody(rateLimitError(), { requestId: 'r2' }, PublicErrorCodes.REQUEST_FAILED),
    ).toEqual({ code: PublicErrorCodes.SERVICE_BUSY, requestId: 'r2' });
  });
});

describe('getErrorSummaries', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the redacted summary only to the user who hit the error', async () => {
    toPublicError(rateLimitError(), {
      requestId: 'req-summary-1',
      userId: 'owner',
      provider: 'openAI',
      model: 'gpt-x',
      conversationId: 'convo-9',
    });

    const summary = await waitForSummary('req-summary-1', 'owner');
    expect(summary).toMatchObject({
      requestId: 'req-summary-1',
      userId: 'owner',
      code: PublicErrorCodes.SERVICE_BUSY,
      status: 429,
      provider: 'openAI',
      model: 'gpt-x',
      conversationId: 'convo-9',
    });
    expect(summary?.message).toContain('Rate limit');

    await expect(getErrorSummaries('req-summary-1', 'someone-else')).resolves.toEqual([]);
  });

  it('returns nothing for an unknown request id', async () => {
    await expect(getErrorSummaries('req-missing', 'owner')).resolves.toEqual([]);
  });
});

describe('captureLoggedErrors', () => {
  afterEach(() => {
    setErrorLogHook(undefined);
  });

  it('keeps a summary of any error logged inside an authenticated request', async () => {
    captureLoggedErrors();
    const error = new Error(
      'Error uploading code environment file: Request failed with status code 404',
    );

    await tenantStorage.run({ requestId: 'req-upload-1', userId: 'owner' }, async () => {
      logger.error('[/files] Error processing file:', error);
    });

    const summary = await waitForSummary('req-upload-1', 'owner');
    expect(summary?.message).toContain('Error uploading code environment file');
    expect(summary?.stack).toContain('Error uploading code environment file');
    await expect(getErrorSummaries('req-upload-1', 'someone-else')).resolves.toEqual([]);
  });

  it('does not store errors logged outside a user request or already captured', async () => {
    captureLoggedErrors();
    logger.error('startup failure');
    await tenantStorage.run({ requestId: 'req-anon-1' }, async () => {
      logger.error('anonymous failure');
    });
    await tenantStorage.run({ requestId: 'req-public-1', userId: 'owner' }, async () => {
      toPublicError(new Error('boom'));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(getErrorSummaries('req-anon-1', 'owner')).resolves.toEqual([]);
    const summaries = await getErrorSummaries('req-public-1', 'owner');
    expect(summaries).toHaveLength(1);
  });
});
