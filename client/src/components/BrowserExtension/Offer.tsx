import { useCallback, useEffect, useState } from 'react';
import { Button, useToastContext } from '@librechat/client';
import type { LinkResult } from './useBrowserTask';
import { useBrowserTask, viaBridge } from './useBrowserTask';
import { useBrowserExtensionCode } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

/** A code lasts 10 minutes on the server; a fresh one is fetched before that, so the click always carries a live one. */
const CODE_REFRESH_MS = 9 * 60 * 1000;
const DISMISSED_PREFIX = 'synapse-browser-offer';

const dismissedKey = (userId: string, accountId: string | undefined) =>
  `${DISMISSED_PREFIX}:${userId}:${accountId ?? 'none'}`;

function wasDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    /* Without storage the card only comes back on the next load. */
  }
}

/** What to offer: to connect a browser that is not, or to switch one that acts as someone else; else nothing. */
function offerFor(
  connected: boolean,
  accountId: string | undefined,
  userId: string | undefined,
): 'connect' | 'switch' | null {
  if (!connected) {
    return 'connect';
  }
  return accountId && accountId !== userId ? 'switch' : null;
}

/**
 * Offers to connect Synapse Browser to the account signed in here, or to switch it when it acts as someone else.
 * One click, never silent: the click shows whose account the extension will act as, and the extension's bridge takes
 * a code only inside a real click. The code is asked for while the card is shown, so the click sends it at once.
 */
export default function Offer() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { user } = useAuthContext();
  const { extension, channel, refresh } = useBrowserTask();
  const code = useBrowserExtensionCode();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const account = extension?.account;
  const mode = offerFor(extension?.connected === true, account?.id, user?.id);
  const key = user?.id ? dismissedKey(user.id, account?.id) : '';
  const show =
    channel === 'bridge' && !!user?.id && mode !== null && !dismissed && !wasDismissed(key);

  const { mutate: getCode } = code;
  useEffect(() => {
    if (!show) return;
    getCode();
    const timer = setInterval(() => getCode(), CODE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [show, getCode]);

  const connect = useCallback(async () => {
    const live = code.data?.code;
    if (!live) return;
    setBusy(true);
    const result = await viaBridge<LinkResult>({ type: 'connect', code: live });
    setBusy(false);
    if (!result?.ok) {
      showToast({ message: localize('com_ui_browser_ext_offer_failed'), status: 'error' });
      getCode();
      return;
    }
    showToast({
      message: localize('com_ui_browser_ext_offer_done', { 0: result.account?.name ?? '' }),
      status: 'success',
    });
    await refresh();
  }, [code.data?.code, getCode, localize, refresh, showToast]);

  /** A server with browser tasks off has no codes to give, and so nothing to offer. */
  if (!show || code.isError || !mode) {
    return null;
  }

  const later = () => {
    rememberDismissed(key);
    setDismissed(true);
  };

  return (
    <section
      aria-labelledby="browser-extension-offer-title"
      className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm space-y-3 rounded-xl border border-border-medium bg-surface-primary p-4 shadow-lg"
    >
      <h2 id="browser-extension-offer-title" className="text-base font-semibold text-text-primary">
        {localize(
          mode === 'switch'
            ? 'com_ui_browser_ext_offer_switch_title'
            : 'com_ui_browser_ext_offer_connect_title',
        )}
      </h2>
      <p className="text-sm text-text-secondary">
        {mode === 'switch'
          ? localize('com_ui_browser_ext_offer_switch_body', {
              0: account?.name ?? '',
              1: user?.name || user?.username || user?.email || '',
            })
          : localize('com_ui_browser_ext_offer_connect_body', {
              0: user?.name || user?.username || user?.email || '',
            })}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={later}>
          {localize('com_ui_browser_ext_offer_later')}
        </Button>
        <Button onClick={() => void connect()} disabled={busy || !code.data?.code}>
          {localize(
            mode === 'switch'
              ? 'com_ui_browser_ext_offer_switch'
              : 'com_ui_browser_ext_offer_connect',
          )}
        </Button>
      </div>
    </section>
  );
}
