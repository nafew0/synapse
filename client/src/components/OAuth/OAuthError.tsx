import React from 'react';
import { Button } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

const OAUTH_ERROR_KEYS: Record<string, TranslationKeys | undefined> = {
  missing_code: 'com_ui_oauth_error_missing_code',
  missing_state: 'com_ui_oauth_error_missing_state',
  invalid_state: 'com_ui_oauth_error_invalid_state',
  callback_failed: 'com_ui_oauth_error_callback_failed',
};

/** Maps the `error` query param to a localization key; unknown values never reach the UI. */
export function getOAuthErrorKey(error: string | null): TranslationKeys {
  return (error ? OAUTH_ERROR_KEYS[error] : undefined) ?? 'com_ui_oauth_error_generic';
}

export default function OAuthError() {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const messageKey = getOAuthErrorKey(searchParams.get('error'));

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-secondary p-8">
      <div className="w-full max-w-md rounded-lg bg-surface-primary p-8 text-center shadow-lg">
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-error-subtle">
            <svg
              className="h-6 w-6 text-status-error"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
        </div>
        <h1 className="mb-4 text-3xl font-bold text-text-primary">
          {localize('com_ui_oauth_error_title')}
        </h1>
        <p className="mb-6 text-sm text-text-secondary">{localize(messageKey)}</p>
        <Button
          variant="default"
          onClick={() => window.close()}
          aria-label={localize('com_ui_close_window')}
        >
          {localize('com_ui_close_window')}
        </Button>
      </div>
    </div>
  );
}
