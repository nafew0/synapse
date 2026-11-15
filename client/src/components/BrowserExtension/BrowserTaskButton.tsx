import { memo, useCallback, useState } from 'react';
import { Globe } from 'lucide-react';
import { IconButton, TooltipAnchor, useToastContext } from '@librechat/client';
import type { ExtendedFile } from '~/common';
import { useLocalize } from '~/hooks';
import { useBrowserTask } from './useBrowserTask';
import { taskFiles } from './files';

/**
 * Hands what the user typed to Synapse Browser, which opens a fresh tab with the task waiting in its panel. The task
 * never starts on its own: the user reads it there and presses send.
 */
function BrowserTaskButton({
  getText,
  getFiles,
  onSent,
  disabled,
}: {
  getText: () => string;
  /** The composer's attachments: those Synapse can read go with the task, by id. */
  getFiles?: () => Map<string, ExtendedFile>;
  onSent: () => void;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { extension, handOver } = useBrowserTask();
  const [busy, setBusy] = useState(false);

  const send = useCallback(async () => {
    const text = getText().trim();
    if (!text) return;
    const { files, skipped } = taskFiles(getFiles?.() ?? new Map());
    setBusy(true);
    const result = await handOver(text, files);
    setBusy(false);
    if (!result?.ok) {
      const reason =
        result?.reason === 'disabled'
          ? 'com_ui_browser_task_off'
          : 'com_ui_browser_task_signed_out';
      showToast({
        message: localize(result ? reason : 'com_ui_browser_task_failed'),
        status: 'warning',
      });
      return;
    }
    // A file left behind is said plainly: a task that quietly read nothing is worse than one that says so.
    showToast({
      message: localize(skipped ? 'com_ui_browser_task_files_skipped' : 'com_ui_browser_task_sent'),
      status: skipped ? 'warning' : 'success',
    });
    onSent();
  }, [getFiles, getText, handOver, localize, onSent, showToast]);

  // Shown only where it can work: the extension is installed in this browser and signed in to Synapse.
  if (!extension?.installed || !extension.connected) return null;

  return (
    <TooltipAnchor
      description={localize('com_ui_browser_task')}
      render={
        <IconButton
          id="browser-task-button"
          type="button"
          variant="ghost"
          size="theme"
          shape="theme"
          label={localize('com_ui_browser_task')}
          onClick={() => void send()}
          disabled={disabled || busy}
          className="p-1 hover:bg-surface-composer-hover"
        >
          <Globe className="size-5 stroke-text-secondary" aria-hidden />
        </IconButton>
      }
    />
  );
}

export default memo(BrowserTaskButton);
