import { useCallback, useEffect, useState } from 'react';

/**
 * Synapse Browser, the browser extension. Its id is fixed by the key in its manifest, so it is the same in every
 * build and on the store; only a page listed in the extension's `externally_connectable` may talk to it, and this
 * app's origin is that page.
 */
export const BROWSER_EXTENSION_ID = 'infhkkgcaahmcnccpfolcghgdcfgnigi';

/**
 * Two ways to reach it. The bridge — a content script the extension puts on this app's pages — carries the click's
 * user activation, which is what Chrome needs before it will open the side panel; without it the task still starts,
 * but the panel waits for the user to open it. The direct call is the fallback.
 */
const BRIDGE_SOURCE = 'synapse-browser';
const BRIDGE_TIMEOUT_MS = 400;

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
  /** Why it could not be taken. Absent when the run has started in a tab of its own. */
  reason?: 'not_connected' | 'disabled' | 'empty';
}

function runtime(): ChromeRuntime | undefined {
  return (window as ExtensionWindow).chrome?.runtime;
}

/** Through the content script, so the click still counts. Null when no bridge answers in time. */
function viaBridge<T>(message: { type: 'ping' | 'task'; text?: string }): Promise<T | null> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random()}`;
    const done = (value: T | null) => {
      window.removeEventListener('message', listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (event: MessageEvent) => {
      const data = event.data as { source?: string; id?: string; reply?: T | null } | null;
      if (event.source !== window || data?.source !== BRIDGE_SOURCE || data.id !== id) return;
      done(data.reply ?? null);
    };
    const timer = setTimeout(() => done(null), BRIDGE_TIMEOUT_MS);
    window.addEventListener('message', listener);
    window.postMessage({ source: BRIDGE_SOURCE, id, ...message }, window.location.origin);
  });
}

/** Straight to the extension. Chrome delivers it, but the panel cannot open without the click's activation. */
function direct<T>(message: unknown): Promise<T | null> {
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
    void (async () => {
      const ping = (await viaBridge<Ping>({ type: 'ping' })) ?? (await direct<Ping>({ type: 'ping' }));
      if (live) setState(ping);
    })();
    return () => {
      live = false;
    };
  }, []);

  const handOver = useCallback(
    async (text: string) =>
      (await viaBridge<TaskResult>({ type: 'task', text })) ?? (await direct<TaskResult>({ type: 'task', text })),
    [],
  );

  return { extension: state, handOver };
}
