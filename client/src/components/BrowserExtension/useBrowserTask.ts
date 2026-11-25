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
/** The bridge answers `hello` itself, without the extension's worker, so its absence is known almost at once. */
const BRIDGE_HELLO_MS = 300;
/** A relayed message waits on the worker: creating a tab takes a moment. */
const BRIDGE_TIMEOUT_MS = 5_000;

interface ChromeRuntime {
  sendMessage: (id: string, message: unknown, callback: (response?: unknown) => void) => void;
  lastError?: { message?: string };
}

type ExtensionWindow = Window & { chrome?: { runtime?: ChromeRuntime } };

/** The Synapse account the extension acts as, as its settings name it. */
export interface ExtensionAccount {
  id: string;
  name: string;
  email: string;
}

export interface Ping {
  installed: true;
  version: string;
  connected: boolean;
  enabled: boolean;
  /** Absent when it is not connected, or connected by a version that does not say as whom. */
  account?: ExtensionAccount;
}

/** What a sign-in or sign-out sent through the bridge came to. */
export interface LinkResult {
  ok: boolean;
  account?: ExtensionAccount;
  /** `no_click`: the bridge takes a sign-in only inside a real click on the page. */
  reason?: 'bad_code' | 'failed' | 'not_yours' | 'no_click';
}

type BridgeRequest =
  | { type: 'hello' | 'ping' }
  | { type: 'task'; text: string; files: TaskFile[] }
  | { type: 'connect'; code: string }
  | { type: 'disconnect'; userId: string };

export interface TaskResult {
  ok: boolean;
  /** Why it could not be taken. Absent when the run has started in a tab of its own. */
  reason?: 'not_connected' | 'disabled' | 'empty';
}

/**
 * A file already uploaded in this chat, named for the extension to read. Only the id travels: the extension asks
 * Synapse for the text with its own sign-in, so the bytes never cross the browser's message channel.
 */
export interface TaskFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
}

function runtime(): ChromeRuntime | undefined {
  return (window as ExtensionWindow).chrome?.runtime;
}

/** Through the content script, so the click still counts. Null when no bridge answers in time. */
export function viaBridge<T>(
  message: BridgeRequest,
  timeout = BRIDGE_TIMEOUT_MS,
): Promise<T | null> {
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
      // Our own request comes back to this listener too, and it carries no `reply`: only an answer ends the wait.
      if (!('reply' in data)) return;
      done(data.reply ?? null);
    };
    const timer = setTimeout(() => done(null), timeout);
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

/** Whether the bridge content script is on this page: it marks the document as soon as it attaches. */
export const hasBridge = (): boolean => !!document.documentElement.dataset.synapseBrowser;

/**
 * The user is signing out of Synapse in this browser: the extension's sign-in ends too when it is theirs, so the next
 * person at this computer cannot run browser tasks as them. Nothing to wait for, and nothing to do without the bridge.
 */
export function disconnectBrowserExtension(userId: string | undefined): void {
  if (!userId || !hasBridge()) return;
  void viaBridge<LinkResult>({ type: 'disconnect', userId });
}

/**
 * Whether this browser has Synapse Browser installed and signed in, and how to hand it a task. The ping settles which
 * way to speak; the task then goes that way only. Trying both in turn would hand the same task over twice whenever the
 * first answer was merely slow.
 */
export function useBrowserTask() {
  const [state, setState] = useState<Ping | null>(null);
  const [channel, setChannel] = useState<'bridge' | 'direct' | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The relay marks the document as soon as it attaches, which may be after this page's script runs.
      let here = hasBridge();
      for (let tries = 0; tries < 4 && !here && live; tries++) {
        here = !!(await viaBridge<{ bridge: true }>({ type: 'hello' }, BRIDGE_HELLO_MS));
      }
      if (!live) return;
      setChannel(here ? 'bridge' : 'direct');
      const ping = here
        ? await viaBridge<Ping>({ type: 'ping' })
        : await direct<Ping>({ type: 'ping' });
      if (live) setState(ping);
    })();
    return () => {
      live = false;
    };
  }, []);

  const handOver = useCallback(
    async (text: string, files: TaskFile[] = []) =>
      channel === 'bridge'
        ? await viaBridge<TaskResult>({ type: 'task', text, files })
        : await direct<TaskResult>({ type: 'task', text, files }),
    [channel],
  );

  /** Asks the extension again, after it was connected or switched from this page. */
  const refresh = useCallback(async () => {
    const ping =
      channel === 'bridge'
        ? await viaBridge<Ping>({ type: 'ping' })
        : await direct<Ping>({ type: 'ping' });
    setState(ping);
  }, [channel]);

  return { extension: state, channel, handOver, refresh };
}
