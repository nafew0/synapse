import OpenAI from 'openai';
import mongoose from 'mongoose';
import axios, { AxiosError } from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { ErrorTypes, ViolationTypes, PublicErrorCodes } from 'librechat-data-provider';
import { classifyError, isAbortError, extractTypedError } from './classify';

const PROVIDER_MESSAGE = 'Rate limit reached for gpt-x in organization org-abc on tokens per min';

function openAIError(status: number, message: string): InstanceType<typeof OpenAI.APIError> {
  return OpenAI.APIError.generate(
    status,
    { error: { message, type: 'requests', code: null } },
    undefined,
    new Headers(),
  );
}

function anthropicError(
  status: number,
  type: string,
  message: string,
): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    new Headers(),
  );
}

function networkError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: -54, syscall: 'read' });
}

describe('classifyError', () => {
  it.each([
    [429, PROVIDER_MESSAGE, PublicErrorCodes.SERVICE_BUSY],
    [400, 'Invalid parameter: messages[0].role', PublicErrorCodes.REQUEST_FAILED],
    [
      500,
      'The server had an error while processing your request',
      PublicErrorCodes.SERVICE_UNAVAILABLE,
    ],
    [401, 'Incorrect API key provided: sk-abc***', PublicErrorCodes.MODEL_UNAVAILABLE],
    [404, 'The model `gpt-x` does not exist', PublicErrorCodes.MODEL_UNAVAILABLE],
    [
      400,
      "This model's maximum context length is 128000 tokens",
      PublicErrorCodes.CONTEXT_TOO_LONG,
    ],
  ])('maps an OpenAI SDK %i error to the matching code', (status, message, expected) => {
    expect(classifyError(openAIError(status, message))).toBe(expected);
  });

  it('maps an Anthropic "prompt is too long" body to context_too_long', () => {
    const error = anthropicError(
      400,
      'invalid_request_error',
      'prompt is too long: 210000 tokens > 200000 maximum',
    );
    expect(classifyError(error)).toBe(PublicErrorCodes.CONTEXT_TOO_LONG);
  });

  it('maps an Anthropic overloaded (529) error to service_busy', () => {
    const error = anthropicError(529, 'overloaded_error', 'Overloaded');
    expect(classifyError(error)).toBe(PublicErrorCodes.SERVICE_BUSY);
  });

  it('maps an undici "terminated" stream error to service_unavailable', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const error = new TypeError('terminated', { cause });
    expect(classifyError(error)).toBe(PublicErrorCodes.SERVICE_UNAVAILABLE);
  });

  it('maps an ECONNRESET socket error to service_unavailable', () => {
    expect(classifyError(networkError('read ECONNRESET', 'ECONNRESET'))).toBe(
      PublicErrorCodes.SERVICE_UNAVAILABLE,
    );
  });

  it('maps an axios error from an internal service by its response status', () => {
    const error = new AxiosError(
      'Request failed with status code 502 (http://rag_api:8000/query)',
      AxiosError.ERR_BAD_RESPONSE,
      undefined,
      undefined,
      {
        status: 502,
        statusText: 'Bad Gateway',
        data: 'upstream error',
        headers: {},
        config: { headers: new axios.AxiosHeaders() },
      },
    );
    expect(classifyError(error)).toBe(PublicErrorCodes.SERVICE_UNAVAILABLE);
  });

  it('maps an axios 404 from an internal service to not_found', () => {
    const error = new AxiosError(
      'Request failed with status code 404 (http://rag_api:8000/documents/abc)',
      AxiosError.ERR_BAD_REQUEST,
      undefined,
      undefined,
      {
        status: 404,
        statusText: 'Not Found',
        data: {},
        headers: {},
        config: { headers: new axios.AxiosHeaders() },
      },
    );
    expect(classifyError(error)).toBe(PublicErrorCodes.NOT_FOUND);
  });

  it('maps a Mongoose CastError to not_found', () => {
    const error = new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
    expect(error.name).toBe('CastError');
    expect(classifyError(error)).toBe(PublicErrorCodes.NOT_FOUND);
  });

  it('maps an AbortError to connection_lost', () => {
    const error = new DOMException('This operation was aborted', 'AbortError');
    expect(isAbortError(error)).toBe(true);
    expect(classifyError(error)).toBe(PublicErrorCodes.CONNECTION_LOST);
  });

  it('maps an Error built from an AbortController signal to connection_lost', () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyError(controller.signal.reason)).toBe(PublicErrorCodes.CONNECTION_LOST);
  });

  it('maps a provider status embedded only in the message text', () => {
    expect(classifyError(new Error(`429 ${PROVIDER_MESSAGE}`))).toBe(PublicErrorCodes.SERVICE_BUSY);
  });

  it('falls back to the cause when the outer error says nothing useful', () => {
    const error = new Error('Something went wrong', {
      cause: networkError('connect ECONNREFUSED 10.0.0.5:8000', 'ECONNREFUSED'),
    });
    expect(classifyError(error)).toBe(PublicErrorCodes.SERVICE_UNAVAILABLE);
  });

  it.each([undefined, null, 42, 'boom', new Error('boom'), {}])(
    'maps an unrecognised value (%p) to unknown',
    (value) => {
      expect(classifyError(value)).toBe(PublicErrorCodes.UNKNOWN);
    },
  );
});

describe('extractTypedError', () => {
  it('keeps token_balance numbers but drops generations', () => {
    const error = new Error(
      JSON.stringify({
        type: ViolationTypes.TOKEN_BALANCE,
        balance: 12,
        tokenCost: 300,
        promptTokens: 150,
        generations: [{ text: 'secret partial output' }],
      }),
    );
    expect(extractTypedError(error)).toEqual({
      type: ViolationTypes.TOKEN_BALANCE,
      balance: 12,
      tokenCost: 300,
      promptTokens: 150,
    });
  });

  it('drops info from a refusal', () => {
    const error = new Error(
      JSON.stringify({ type: ErrorTypes.REFUSAL, info: 'stop_reason: refusal, model: claude-x' }),
    );
    expect(extractTypedError(error)).toEqual({ type: ErrorTypes.REFUSAL });
  });

  it('drops raw error text from a violation payload', () => {
    const text = JSON.stringify({
      type: ViolationTypes.CONVO_ACCESS,
      error: 'User not authorized for this conversation',
    });
    expect(extractTypedError(text)).toEqual({ type: ViolationTypes.CONVO_ACCESS });
  });

  it('reads a typed error code set on the error object', () => {
    const error = Object.assign(new Error('Attached resources must be restored'), {
      code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
    });
    expect(extractTypedError(error)).toEqual({ type: ErrorTypes.RESOURCE_RECOVERY_REQUIRED });
  });

  it('ignores JSON whose type is not a known error type', () => {
    expect(extractTypedError(new Error('{"type":"whatever","detail":"x"}'))).toBeUndefined();
    expect(extractTypedError(new Error(PROVIDER_MESSAGE))).toBeUndefined();
  });
});
