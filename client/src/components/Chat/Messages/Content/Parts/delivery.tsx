import { createContext, useContext } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** False while the reply that delivered a file is still running, so its download waits for the final, checked version. */
const DeliveryContext = createContext(true);

export const DeliveryProvider = DeliveryContext.Provider;

export const useDownloadReady = (): boolean => useContext(DeliveryContext);

/** Holds a card's download slot while the reply runs, keeping the card's shape. */
export function PendingDownload() {
  const localize = useLocalize();
  const label = localize('com_ui_download_after_reply');
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'flex shrink-0 items-center justify-center px-3',
        'rounded-r-xl border-l border-border-light bg-surface-tertiary text-text-secondary',
      )}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
    </span>
  );
}
