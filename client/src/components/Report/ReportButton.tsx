import { useState } from 'react';
import { Check, Flag } from 'lucide-react';
import { Button } from '@librechat/client';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import ReportDialog from './ReportDialog';
import { cn } from '~/utils';

type ReportButtonProps = {
  code?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  className?: string;
};

/** Request ids already reported in this session; one report per request id. */
const reportedRequests = new Set<string>();

export const isReported = (requestId?: string): boolean =>
  requestId != null && reportedRequests.has(requestId);

export const resetReported = (): void => reportedRequests.clear();

export default function ReportButton({
  code,
  requestId,
  conversationId,
  messageId,
  className,
}: ReportButtonProps) {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState(() => isReported(requestId));

  if (startupConfig?.issueReportsEnabled !== true) {
    return null;
  }

  const handleSent = () => {
    if (!requestId) {
      return;
    }
    reportedRequests.add(requestId);
    setReported(true);
  };

  const done = reported || isReported(requestId);
  const label = localize(done ? 'com_ui_report_issue_reported' : 'com_ui_report_issue');

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={done}
        aria-label={label}
        onClick={() => setOpen(true)}
        className={cn('h-8 gap-1.5 px-2 text-xs text-text-secondary', className)}
      >
        {done ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Flag className="size-3.5" aria-hidden="true" />
        )}
        {label}
      </Button>
      {open && (
        <ReportDialog
          open={open}
          onOpenChange={setOpen}
          onSent={handleSent}
          code={code}
          requestId={requestId}
          conversationId={conversationId}
          messageId={messageId}
        />
      )}
    </>
  );
}
