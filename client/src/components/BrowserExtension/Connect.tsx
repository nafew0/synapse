import { Button } from '@librechat/client';
import { useBrowserExtensionCode, useSignOutBrowserExtensions } from '~/data-provider';
import { useLocalize } from '~/hooks';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Shows a one-time code to type into the Synapse Browser extension, which signs it in to this account. */
export default function Connect() {
  const localize = useLocalize();
  const code = useBrowserExtensionCode();
  const signOut = useSignOutBrowserExtensions();

  return (
    <main className="flex h-full w-full items-start justify-center overflow-y-auto bg-surface-primary p-4 sm:pt-16">
      <section
        aria-labelledby="browser-extension-connect-title"
        className="w-full max-w-md space-y-4 rounded-xl border border-border-light p-6"
      >
        <h1
          id="browser-extension-connect-title"
          className="text-xl font-semibold text-text-primary"
        >
          {localize('com_ui_browser_ext_connect_title')}
        </h1>
        <p className="text-sm text-text-secondary">
          {localize('com_ui_browser_ext_connect_intro')}
        </p>
        {code.data ? (
          <div className="space-y-2" role="status">
            <p
              className="select-all text-center font-mono text-3xl font-semibold tracking-widest text-text-primary"
              aria-label={localize('com_ui_browser_ext_code_label')}
            >
              {code.data.code}
            </p>
            <p className="text-center text-xs text-text-secondary">
              {localize('com_ui_browser_ext_code_expires', { 0: time(code.data.expiresAt) })}
            </p>
          </div>
        ) : null}
        {code.isError ? (
          <p role="alert" className="text-sm text-text-warning">
            {localize('com_ui_browser_ext_error')}
          </p>
        ) : null}
        <Button onClick={() => code.mutate()} disabled={code.isLoading}>
          {localize(code.data ? 'com_ui_browser_ext_new_code' : 'com_ui_browser_ext_get_code')}
        </Button>
        <div className="border-t border-border-light pt-4">
          <p className="mb-2 text-xs text-text-secondary">
            {localize('com_ui_browser_ext_sign_out_hint')}
          </p>
          <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isLoading}>
            {localize('com_ui_browser_ext_sign_out')}
          </Button>
          {signOut.data ? (
            <p role="status" className="mt-2 text-xs text-text-secondary">
              {localize('com_ui_browser_ext_signed_out', { 0: signOut.data.removed })}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
