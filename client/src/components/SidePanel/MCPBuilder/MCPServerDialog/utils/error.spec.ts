import type { TranslationKeys } from '~/hooks';
import { getMCPServerErrorMessage } from './error';

const localize = (key: TranslationKeys): string => `localized:${key}`;
const fallbackKey = 'com_ui_mcp_server_save_error' as TranslationKeys;

const axiosError = (status: number, data: object | string) => ({
  message: 'Request failed with status code 500',
  response: { status, data, headers: {} },
});

describe('getMCPServerErrorMessage', () => {
  it.each([
    ['MCP_INSPECTION_FAILED', 'com_ui_mcp_server_connection_failed'],
    ['MCP_DOMAIN_NOT_ALLOWED', 'com_ui_mcp_domain_not_allowed'],
    ['MCP_OAUTH_SECRET_REENTRY_REQUIRED', 'com_ui_mcp_oauth_secret_reentry_required'],
  ] as const)('localizes %s', (errorCode, messageKey) => {
    expect(
      getMCPServerErrorMessage(axiosError(400, { error: errorCode }), localize, fallbackKey),
    ).toBe(`localized:${messageKey}`);
  });

  it('reads a known code from a `code` field', () => {
    expect(
      getMCPServerErrorMessage(
        axiosError(400, { code: 'MCP_DOMAIN_NOT_ALLOWED' }),
        localize,
        fallbackKey,
      ),
    ).toBe('localized:com_ui_mcp_domain_not_allowed');
  });

  it('falls back to the feature key for an unknown code instead of the raw code', () => {
    const message = getMCPServerErrorMessage(
      axiosError(400, { error: 'UNKNOWN_ERROR' }),
      localize,
      fallbackKey,
    );
    expect(message).toBe(`localized:${fallbackKey}`);
    expect(message).not.toContain('UNKNOWN_ERROR');
  });

  it('never exposes raw server text', () => {
    const message = getMCPServerErrorMessage(
      axiosError(500, { error: 'ECONNREFUSED 10.0.0.5:8080 at mongo.internal' }),
      localize,
      fallbackKey,
    );
    expect(message).toBe(`localized:${fallbackKey}`);
  });

  it('never exposes a thrown Error message', () => {
    const message = getMCPServerErrorMessage(
      new Error('TypeError: cannot read x'),
      localize,
      fallbackKey,
    );
    expect(message).toBe(`localized:${fallbackKey}`);
  });

  it('keeps specific conditions such as permission errors', () => {
    expect(getMCPServerErrorMessage(axiosError(403, {}), localize, fallbackKey)).toBe(
      'localized:com_error_forbidden',
    );
  });
});
