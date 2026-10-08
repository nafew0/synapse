import { useCallback, useMemo } from 'react';
import { NotificationSeverity, ToastContext, useToastContext } from '@librechat/client';
import type { ReactNode } from 'react';
import type { TShowToast } from '@librechat/client';
import { getRecentErrors } from '~/utils/errors';
import useReportIssue from './useReportIssue';
import { useLocalize } from '~/hooks';

/** An error recorded this recently is the one the toast is about. */
const MATCH_WINDOW_MS = 5000;
const REPORTABLE_TOAST_MS = 8000;

function isErrorToast(toast: TShowToast): boolean {
  return toast.status === 'error' || toast.severity === NotificationSeverity.ERROR;
}

function latestError() {
  const [latest] = getRecentErrors();
  if (!latest?.occurredAt) {
    return undefined;
  }
  const age = Date.now() - new Date(latest.occurredAt).getTime();
  return age <= MATCH_WINDOW_MS ? latest : undefined;
}

/**
 * Adds a "Report an issue" button to every error toast, prefilled with the
 * error the user just hit and the message they saw.
 */
export default function ReportToastProvider({ children }: { children: ReactNode }) {
  const localize = useLocalize();
  const { showToast: baseShowToast } = useToastContext();
  const { openReport } = useReportIssue();

  const showToast = useCallback(
    (toast: TShowToast) => {
      if (!openReport || toast.action || !isErrorToast(toast)) {
        baseShowToast(toast);
        return;
      }
      const error = latestError();
      baseShowToast({
        ...toast,
        duration: Math.max(toast.duration ?? 0, REPORTABLE_TOAST_MS),
        action: {
          label: localize('com_ui_report_issue'),
          onClick: () =>
            openReport({
              code: error?.code ?? 'unknown',
              requestId: error?.requestId,
              shownMessage: toast.message,
            }),
        },
      });
    },
    [baseShowToast, localize, openReport],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
