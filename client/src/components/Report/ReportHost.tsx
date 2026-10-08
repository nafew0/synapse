import { useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { reportRequestAtom, reportedRequestsAtom } from './store';
import ReportDialog from './ReportDialog';

/** Renders the single report dialog; mounted once at the app root. */
export default function ReportHost() {
  const [request, setRequest] = useAtom(reportRequestAtom);
  const setReported = useSetAtom(reportedRequestsAtom);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setRequest(null);
      }
    },
    [setRequest],
  );

  const handleSent = useCallback(() => {
    const requestId = request?.requestId;
    if (!requestId) {
      return;
    }
    setReported((prev) => new Set(prev).add(requestId));
  }, [request?.requestId, setReported]);

  if (!request) {
    return null;
  }

  return (
    <ReportDialog
      key={`${request.requestId ?? ''}:${request.shownMessage ?? ''}`}
      open
      onOpenChange={handleOpenChange}
      onSent={handleSent}
      {...request}
    />
  );
}
