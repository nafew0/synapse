import type { TranslationKeys } from '~/hooks';
import { getErrorMessage } from '~/utils/errors';

type Localize = (key: TranslationKeys) => string;

type TMCPErrorBody = { error?: unknown; code?: unknown };

const MCP_ERROR_MESSAGE_KEYS: Record<string, TranslationKeys | undefined> = {
  MCP_INSPECTION_FAILED: 'com_ui_mcp_server_connection_failed',
  MCP_DOMAIN_NOT_ALLOWED: 'com_ui_mcp_domain_not_allowed',
  MCP_OAUTH_SECRET_REENTRY_REQUIRED: 'com_ui_mcp_oauth_secret_reentry_required',
};

function getMCPErrorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== 'object' || !('response' in error)) {
    return undefined;
  }
  const { response } = error as { response?: { data?: TMCPErrorBody } };
  const data = response?.data;
  if (data == null || typeof data !== 'object') {
    return undefined;
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  return typeof data.code === 'string' ? data.code : undefined;
}

/**
 * Localized message for an MCP server save/delete failure. Known MCP codes get their
 * specific text; anything else (including unknown codes) never surfaces raw server text.
 */
export function getMCPServerErrorMessage(
  error: unknown,
  localize: Localize,
  fallbackKey: TranslationKeys,
): string {
  const code = getMCPErrorCode(error);
  const messageKey = code ? MCP_ERROR_MESSAGE_KEYS[code] : undefined;
  if (messageKey) {
    return localize(messageKey);
  }
  return getErrorMessage(error, localize, fallbackKey);
}
