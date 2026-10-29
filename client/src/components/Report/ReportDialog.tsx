import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Label,
  Button,
  Spinner,
  Checkbox,
  OGDialog,
  Textarea,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import { QueryKeys, toErrorReference, ISSUE_REPORT_LIMITS } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TReportContext } from './payload';
import { useCreateIssueReportMutation, useGetStartupConfig } from '~/data-provider';
import { buildReport, getLastUserMessage, knownConversation } from './payload';
import { getResponseStatus } from '~/utils/errors';
import { useLocalize } from '~/hooks';

export const DEFAULT_SUPPORT_EMAIL = 'info@bdren.ai';

type ReportDialogProps = TReportContext & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
};

export default function ReportDialog({
  open,
  onOpenChange,
  onSent,
  ...context
}: ReportDialogProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { data: startupConfig } = useGetStartupConfig();
  const [description, setDescription] = useState('');
  const [includeMessage, setIncludeMessage] = useState(true);
  const [failed, setFailed] = useState(false);
  const mutation = useCreateIssueReportMutation();
  const fieldId = useId();
  const checkboxId = useId();
  const hintId = useId();

  const conversationId = knownConversation(context.conversationId);
  const reference = toErrorReference(context.requestId);
  const supportEmail = startupConfig?.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  const handleSend = () => {
    const lastMessage =
      includeMessage && conversationId
        ? getLastUserMessage(
            queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]),
          )
        : undefined;
    const payload = buildReport({ context, description, lastMessage, startupConfig });
    setFailed(false);
    mutation.mutate(payload, {
      onSuccess: () => {
        setDescription('');
        setIncludeMessage(false);
        onSent?.();
        onOpenChange(false);
        showToast({ message: localize('com_ui_report_issue_sent'), status: 'success' });
      },
      onError: (error) => {
        if (getResponseStatus(error) === 429) {
          showToast({ message: localize('com_ui_report_issue_rate_limited'), status: 'warning' });
          return;
        }
        setFailed(true);
      },
    });
  };

  const isSending = mutation.isLoading;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-lg">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_report_issue')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="flex flex-col gap-4">
          {context.shownMessage && (
            <p className="rounded-md border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary">
              {context.shownMessage}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId} className="text-sm text-text-primary">
              {localize('com_ui_report_issue_label')}
            </Label>
            <Textarea
              id={fieldId}
              value={description}
              maxLength={ISSUE_REPORT_LIMITS.description}
              placeholder={localize('com_ui_report_issue_placeholder')}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-28"
            />
          </div>
          {conversationId && (
            <div className="flex items-start gap-2">
              <Checkbox
                id={checkboxId}
                checked={includeMessage}
                onCheckedChange={(checked) => setIncludeMessage(checked === true)}
                aria-labelledby={`${checkboxId}-label`}
                aria-describedby={hintId}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label
                  id={`${checkboxId}-label`}
                  htmlFor={checkboxId}
                  className="cursor-pointer text-sm text-text-primary"
                >
                  {localize('com_ui_report_issue_include_message')}
                </Label>
                <span id={hintId} className="text-xs text-text-secondary">
                  {localize('com_ui_report_issue_include_message_hint')}
                </span>
              </div>
            </div>
          )}
          <p className="text-xs text-text-secondary">
            {localize('com_ui_report_issue_details_hint')}
            {reference && <> {localize('com_error_reference', { 0: reference })}</>}
          </p>
          {failed && (
            <p role="alert" className="text-sm text-text-destructive">
              {localize('com_ui_report_issue_failed', { 0: supportEmail })}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <OGDialogClose asChild>
            <Button variant="outline" aria-label={localize('com_ui_cancel')}>
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
          <Button
            variant="submit"
            onClick={handleSend}
            disabled={isSending}
            aria-busy={isSending}
            aria-label={localize('com_ui_report_issue_send')}
          >
            {isSending ? <Spinner className="size-4" /> : localize('com_ui_report_issue_send')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
