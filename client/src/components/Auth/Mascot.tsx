import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { Mascot, useTheme, isDark } from '@librechat/client';
import type { MascotInput, MascotInputSource } from '@librechat/client';
import type { ReactNode } from 'react';
import { useLocalize } from '~/hooks';

/**
 * The form tells the mascot four things and nothing else: whether the password
 * field holds focus, that a key went down (a timestamp, never which key),
 * whether a submit is in flight, and how it ended. No field value reaches the
 * rig, and none should ever be added here.
 */
export interface MascotController {
  setSecretFocused: (focused: boolean) => void;
  setSubmitting: (submitting: boolean) => void;
  noteKeystroke: () => void;
  noteFailure: () => void;
  noteSuccess: () => void;
}

const NOOP: MascotController = {
  setSecretFocused: () => undefined,
  setSubmitting: () => undefined,
  noteKeystroke: () => undefined,
  noteFailure: () => undefined,
  noteSuccess: () => undefined,
};

const MascotContext = createContext<MascotController>(NOOP);

/** Safe outside the provider, so the register and reset screens need no changes. */
export const useMascot = (): MascotController => useContext(MascotContext);

/**
 * Holds the signals in a ref rather than state. Keystrokes and focus changes
 * would otherwise re-render the whole auth card several times a second, and
 * the rig reads them once per frame anyway.
 */
export function MascotProvider({ children }: { children: ReactNode }) {
  const inputRef = useRef<MascotInput>({
    secretFocused: false,
    submitting: false,
    succeeded: false,
    failedAt: 0,
    lastKeyAt: 0,
  });

  const value = useMemo<MascotController>(
    () => ({
      setSecretFocused: (focused) => {
        inputRef.current.secretFocused = focused;
      },
      setSubmitting: (submitting) => {
        inputRef.current.submitting = submitting;
      },
      noteKeystroke: () => {
        inputRef.current.lastKeyAt = performance.now();
      },
      noteFailure: () => {
        inputRef.current.submitting = false;
        inputRef.current.failedAt = performance.now();
      },
      noteSuccess: () => {
        inputRef.current.submitting = false;
        inputRef.current.succeeded = true;
      },
    }),
    [],
  );

  const source = useMemo<MascotInputSource>(() => ({ read: () => inputRef.current }), []);

  return (
    <MascotContext.Provider value={value}>
      <MascotSourceContext.Provider value={source}>{children}</MascotSourceContext.Provider>
    </MascotContext.Provider>
  );
}

const MascotSourceContext = createContext<MascotInputSource | null>(null);

/**
 * The brand lockup: the rig, then the wordmark as its own element. The shipped
 * logo files bake both into one SVG, so the icon could not move without
 * dragging the wordmark with it.
 */
export function AuthLockup({ appTitle }: { appTitle: string }) {
  const localize = useLocalize();
  const { theme } = useTheme();
  const dark = isDark(theme);
  const source = useContext(MascotSourceContext);

  if (!source) {
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Mascot
        source={source}
        variant={dark ? 'white' : 'teal'}
        className="h-32 w-32 lg:h-44 lg:w-44"
        title={localize('com_ui_logo', { 0: appTitle })}
      />
      <img
        src={dark ? '/assets/wordmark_synapse_white.svg' : '/assets/wordmark_synapse.svg'}
        className="h-6 w-auto lg:h-8"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    </div>
  );
}

/**
 * Mirrors an auth error into the rig. It fires on a failed submit response,
 * never on field validation — a malformed email should not make the mascot
 * flinch — and it runs alongside the visible error, never instead of it.
 *
 * Arming on each attempt matters: two failed sign-ins produce the same error
 * string, so watching the message alone would show the beat once and then go
 * quiet for every attempt after it.
 */
export function useMascotFailure(error: unknown, submitting: boolean): void {
  const { noteFailure } = useMascot();
  const armed = useRef(false);

  useEffect(() => {
    if (submitting) {
      armed.current = true;
      return;
    }
    if (!armed.current || error === null || error === undefined || error === '') {
      return;
    }
    armed.current = false;
    noteFailure();
  }, [error, submitting, noteFailure]);
}
