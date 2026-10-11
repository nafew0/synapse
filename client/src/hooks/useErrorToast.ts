import { useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import type { TranslationKeys } from './useLocalize';
import { getErrorInfo, getErrorMessage, recordError } from '~/utils/errors';
import useLocalize from './useLocalize';

/** Shows a friendly, localized error toast and records the error for issue reports. */
export default function useErrorToast() {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  return useCallback(
    (error: unknown, fallbackKey?: TranslationKeys) => {
      recordError(getErrorInfo(error));
      showToast({ message: getErrorMessage(error, localize, fallbackKey), status: 'error' });
    },
    [localize, showToast],
  );
}
