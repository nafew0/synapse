import { useEffect, useRef } from 'react';
import { useToastContext } from '@librechat/client';
import { ACCOUNT_MOVING_EVENT } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** How long one notice covers, so a burst of held-back requests shows it once. */
const NOTICE_INTERVAL_MS = 10_000;

/**
 * Tells the person, once per burst, that their account is moving to another institution while
 * requests are held back and retried (`ACCOUNT_MOVING`).
 */
export default function AccountMovingNotice() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const lastShown = useRef(0);

  useEffect(() => {
    const onMoving = () => {
      const now = Date.now();
      if (now - lastShown.current < NOTICE_INTERVAL_MS) {
        return;
      }
      lastShown.current = now;
      showToast({ message: localize('com_ui_account_moving'), status: 'info' });
    };
    window.addEventListener(ACCOUNT_MOVING_EVENT, onMoving);
    return () => window.removeEventListener(ACCOUNT_MOVING_EVENT, onMoving);
  }, [localize, showToast]);

  return null;
}
