import { useCallback, useEffect, useState } from 'react';

/**
 * Synapse Browser, the browser extension. Its id is fixed by the key in its manifest, so it is the same in every
 * build and on the store; only a page listed in the extension's `externally_connectable` may talk to it, and this
 * app's origin is that page.
 */
export const BROWSER_EXTENSION_ID = 'infhkkgcaahmcnccpfolcghgdcfgnigi';

interface ChromeRuntime {
  sendMessage: (id: string, message: unknown, callback: (response?: unknown) => void) => void;
  lastError?: { message?: string };
}

type ExtensionWindow = Window & { chrome?: { runtime?: ChromeRuntime } };

interface Ping {
  installed: true;
  version: string;
  connected: boolean;
  enabled: boolean;
}

export interface TaskResult {
  ok: boolean;
  /** False when the panel could not open by itself: the user clicks the extension's button to see the task. */
  opened: boolean;
  reason?: 'not_connected' | 'disabled' | 'empty';
}

function runtime(): ChromeRuntime | undefined {
  return (window as ExtensionWindow).chrome?.runtime;
}

function send<T>(message: unknown): Promise<T | null> {
  const api = runtime();
  if (!api?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.sendMessage(BROWSER_EXTENSION_ID, message, (response?: unknown) => {
        // Reading lastError is what stops Chrome logging "Unchecked runtime.lastError" when nothing answers.
        const failed = runtime()?.lastError;
        resolve(failed || response === undefined ? null : (response as T));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Whether this browser has Synapse Browser installed and signed in, and how to hand it a task. */
export function useBrowserTask() {
  const [state, setState] = useState<Ping | null>(null);

  useEffect(() => {
    let live = true;
    void send<Ping>({ type: 'ping' }).then((ping) => live && setState(ping));
    return () => {
      live = false;
    };
  }, []);

  const handOver = useCallback(
    (text: string) => send<TaskResult>({ type: 'task', text }),
    [],
  );

  return { extension: state, handOver };
}
