import { Check, Flag } from 'lucide-react';
import { Button } from '@librechat/client';
import type { TReportContext } from './payload';
import useReportIssue from './useReportIssue';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ReportButtonProps = TReportContext & {
  className?: string;
};

export default function ReportButton({ className, ...context }: ReportButtonProps) {
  const localize = useLocalize();
  const { openReport, isReported } = useReportIssue();

  if (!openReport) {
    return null;
  }

  const done = isReported(context.requestId);
  const label = localize(done ? 'com_ui_report_issue_reported' : 'com_ui_report_issue');

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={done}
      aria-label={label}
      onClick={() => openReport(context)}
      className={cn('h-8 gap-1.5 px-2 text-xs text-text-secondary', className)}
    >
      {done ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Flag className="size-3.5" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
