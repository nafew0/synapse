import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { TReportContext } from './payload';
import { reportRequestAtom, reportedRequestsAtom } from './store';
import { useGetStartupConfig } from '~/data-provider';

/**
 * Opens the shared report dialog for an error. Returns `null` when reporting is
 * disabled (no email transport or support address configured).
 */
export default function useReportIssue() {
  const { data: startupConfig } = useGetStartupConfig();
  const setRequest = useSetAtom(reportRequestAtom);
  const reported = useAtomValue(reportedRequestsAtom);
  const enabled = startupConfig?.issueReportsEnabled === true;

  const openReport = useCallback((context: TReportContext) => setRequest(context), [setRequest]);
  const isReported = useCallback(
    (requestId?: string) => requestId != null && reported.has(requestId),
    [reported],
  );

  return { openReport: enabled ? openReport : null, isReported };
}
