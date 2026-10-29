import { PublicErrorCodes } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  getErrorInfo,
  recordError,
  getErrorMessage,
  getRecentErrors,
  clearRecentErrors,
} from '../errors';

const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const localize = (key: TranslationKeys) => key;

describe('getErrorInfo', () => {
  it('reads the code and request id from an API error body', () => {
    const error = {
      response: { status: 429, data: { code: 'service_busy', requestId: REQUEST_ID } },
    };
    expect(getErrorInfo(error)).toEqual({
      code: 'service_busy',
      status: 429,
      requestId: REQUEST_ID,
    });
  });

  it('keeps the request id of an upload failure that has no code', () => {
    const uploadError = {
      code: 500,
      requestId: REQUEST_ID,
      response: { status: 500, data: { message: 'raw server text', requestId: REQUEST_ID } },
    };
    expect(getErrorInfo(uploadError)).toEqual({
      code: PublicErrorCodes.UNKNOWN,
      status: 500,
      requestId: REQUEST_ID,
    });
  });

  it('falls back to the request id header', () => {
    const error = {
      response: { status: 503, data: {}, headers: { 'x-request-id': REQUEST_ID } },
    };
    expect(getErrorInfo(error)).toMatchObject({
      code: PublicErrorCodes.SERVICE_UNAVAILABLE,
      requestId: REQUEST_ID,
    });
  });

  it('treats a request with no response as a connection problem', () => {
    expect(getErrorInfo({ message: 'Network Error', request: {} }).code).toBe(
      PublicErrorCodes.SERVICE_UNAVAILABLE,
    );
  });
});

describe('getErrorMessage', () => {
  it('never returns the server message', () => {
    const error = { response: { status: 500, data: { message: 'ECONNREFUSED 10.0.0.5:8000' } } };
    const message = getErrorMessage(error, localize, 'com_error_files_upload');
    expect(message).toBe('com_error_files_upload');
  });

  it('prefers the specific text for a specific condition', () => {
    const error = { response: { status: 429, data: {} } };
    expect(getErrorMessage(error, localize, 'com_error_files_upload')).toBe(
      'com_error_service_busy',
    );
  });
});

describe('recent errors', () => {
  beforeEach(() => clearRecentErrors());

  it('keeps the latest five, newest first, and persists them for the tab', () => {
    for (let i = 0; i < 7; i++) {
      recordError({ code: `code_${i}`, requestId: `req-${i}` });
    }
    const recent = getRecentErrors();
    expect(recent).toHaveLength(5);
    expect(recent[0]).toMatchObject({ code: 'code_6', requestId: 'req-6' });
    expect(JSON.parse(sessionStorage.getItem('synapse:recentErrors') ?? '[]')).toHaveLength(5);
  });

  it('records each request id once', () => {
    recordError({ code: 'unknown', requestId: REQUEST_ID });
    recordError({ code: 'unknown', requestId: REQUEST_ID });
    expect(getRecentErrors()).toHaveLength(1);
  });
});
