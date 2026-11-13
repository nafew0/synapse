import { memo, useCallback, useState } from 'react';
import { Globe } from 'lucide-react';
import { IconButton, TooltipAnchor, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { useBrowserTask } from './useBrowserTask';

/**
 * Hands what the user typed to Synapse Browser, which opens a fresh tab with the task waiting in its panel. The task
 * never starts on its own: the user reads it there and presses send.
 */
function BrowserTaskButton({ getText, onSent, disabled }: {
  getText: () => string;
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
    setBusy(true);
    const result = await handOver(text);
    setBusy(false);
    if (!result?.ok) {
      const reason = result?.reason === 'disabled' ? 'com_ui_browser_task_off' : 'com_ui_browser_task_signed_out';
      showToast({ message: localize(result ? reason : 'com_ui_browser_task_failed'), status: 'warning' });
      return;
    }
    showToast({ message: localize('com_ui_browser_task_sent'), status: 'success' });
    onSent();
  }, [getText, handOver, localize, onSent, showToast]);

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
