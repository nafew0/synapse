import { useRef, useState, useEffect, useCallback } from 'react';
import { dataService } from 'librechat-data-provider';
import type { PhoneUploadFile, PhoneUploadSessionCreated } from 'librechat-data-provider';
import { useCreatePhoneUploadSession, usePhoneUploadSession } from '~/data-provider/Files/phone';

export type PhoneUploadState = 'starting' | 'ready' | 'expired' | 'error';

interface PhoneSessionOptions {
  /** A session is open, and a code shown or waiting in the background, while this is true. */
  active: boolean;
  endpoint?: string | null;
  endpointType?: string | null;
  /** Receives each batch of phone files, ready to upload like files picked on this computer. */
  onFiles: (files: File[]) => void;
  onFileError: (file: PhoneUploadFile) => void;
}

export interface PhoneUploadView {
  state: PhoneUploadState;
  link?: string;
  expiresAt?: string;
  received: PhoneUploadFile[];
  /** The phone page is open and checking in. */
  phoneConnected: boolean;
  restart: () => void;
}

interface Collected {
  staged: PhoneUploadFile;
  file: File;
}

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

/** The phone page sits next to the app, under the same base path as the router. */
export const buildPhoneLink = (token: string): string => {
  const base = document.querySelector('base')?.getAttribute('href') || '/';
  const root = new URL(base, window.location.origin);
  return new URL(`phone/${encodeURIComponent(token)}`, root).toString();
};

const closeQuietly = (sessionId: string) => {
  dataService.closePhoneUploadSession(sessionId).catch(() => undefined);
};

/**
 * Opens an "upload from phone" session while `active` is true, collects every file the phone
 * sends and hands it to `onFiles`, and closes the session when it goes inactive or unmounts.
 */
export function usePhoneSession({
  active,
  endpoint,
  endpointType,
  onFiles,
  onFileError,
}: PhoneSessionOptions): PhoneUploadView {
  const [session, setSession] = useState<PhoneUploadSessionCreated | undefined>();
  const [state, setState] = useState<PhoneUploadState>('starting');
  const [received, setReceived] = useState<PhoneUploadFile[]>([]);
  const seen = useRef(new Set<string>());
  const sessionIdRef = useRef<string | undefined>();
  const callbacks = useRef({ onFiles, onFileError });
  callbacks.current = { onFiles, onFileError };

  const { mutate: createSession } = useCreatePhoneUploadSession();
  const poll = usePhoneUploadSession(session?.sessionId, active && state === 'ready');

  const start = useCallback(() => {
    seen.current = new Set();
    setReceived([]);
    setSession(undefined);
    setState('starting');
    createSession(
      { endpoint, endpointType },
      {
        onSuccess: (created) => {
          sessionIdRef.current = created.sessionId;
          setSession(created);
          setState('ready');
        },
        onError: () => setState('error'),
      },
    );
  }, [createSession, endpoint, endpointType]);

  const end = useCallback(() => {
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = undefined;
    if (sessionId) {
      closeQuietly(sessionId);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    start();
    return end;
    // Endpoint changes mid-session keep the open code; a new code starts on the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (poll.isError) {
      setState(statusOf(poll.error) === 410 ? 'expired' : 'error');
    }
  }, [poll.isError, poll.error]);

  useEffect(() => {
    const sessionId = session?.sessionId;
    const incoming = (poll.data?.files ?? []).filter((file) => !seen.current.has(file.fileId));
    if (!sessionId || incoming.length === 0) {
      return;
    }
    incoming.forEach((file) => seen.current.add(file.fileId));

    const collect = async (staged: PhoneUploadFile): Promise<Collected | null> => {
      try {
        const blob = await dataService.downloadPhoneUploadFile(sessionId, staged.fileId);
        return { staged, file: new File([blob], staged.filename, { type: staged.mimeType }) };
      } catch {
        callbacks.current.onFileError(staged);
        return null;
      }
    };

    Promise.all(incoming.map(collect)).then((results) => {
      const collected = results.filter((result): result is Collected => result != null);
      if (collected.length === 0) {
        return;
      }
      setReceived((prev) => [...prev, ...collected.map(({ staged }) => staged)]);
      callbacks.current.onFiles(collected.map(({ file }) => file));
    });
  }, [poll.data, session?.sessionId]);

  useEffect(() => {
    if (state !== 'ready' || !session) {
      return;
    }
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    const timer = setTimeout(() => setState('expired'), Math.max(remaining, 0));
    return () => clearTimeout(timer);
  }, [state, session]);

  const restart = useCallback(() => {
    end();
    start();
  }, [end, start]);

  return {
    state,
    link: session ? buildPhoneLink(session.token) : undefined,
    expiresAt: session?.expiresAt,
    received,
    phoneConnected: state === 'ready' && poll.data?.phoneConnected === true,
    restart,
  };
}

interface UsePhoneUploadOptions extends Omit<PhoneSessionOptions, 'active'> {
  /** The chat the files belong to; switching chats ends the session. */
  conversationId: string;
}

export interface PhoneUpload {
  view: PhoneUploadView;
  isDialogOpen: boolean;
  openDialog: () => void;
  setDialogOpen: (open: boolean) => void;
}

/**
 * The "Upload from phone" flow for one chat. The dialog closes as soon as files arrive so they
 * show in the composer, while the code keeps working in the background until it expires, so the
 * phone can send more. Closing the dialog before anything arrived, or leaving the chat, ends it.
 */
export default function usePhoneUpload({
  conversationId,
  onFiles,
  ...options
}: UsePhoneUploadOptions): PhoneUpload {
  const [active, setActive] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const view = usePhoneSession({
    ...options,
    active,
    onFiles: (files) => {
      setIsDialogOpen(false);
      onFiles(files);
    },
  });

  useEffect(() => {
    setActive(false);
    setIsDialogOpen(false);
  }, [conversationId]);

  useEffect(() => {
    if (!isDialogOpen && view.state !== 'ready' && view.state !== 'starting') {
      setActive(false);
    }
  }, [isDialogOpen, view.state]);

  const openDialog = useCallback(() => {
    setActive(true);
    setIsDialogOpen(true);
  }, []);

  const hasReceived = view.received.length > 0;
  const setDialogOpen = useCallback(
    (open: boolean) => {
      setIsDialogOpen(open);
      if (!open && !hasReceived) {
        setActive(false);
      }
    },
    [hasReceived],
  );

  return { view, isDialogOpen, openDialog, setDialogOpen };
}
