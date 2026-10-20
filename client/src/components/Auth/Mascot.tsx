import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Mascot, useTheme, isDark } from '@librechat/client';
import type { MascotInput, MascotInputSource, MascotEntrance } from '@librechat/client';
import type { UseFormRegisterReturn } from 'react-hook-form';
import type { ReactNode, FocusEvent } from 'react';
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

/** Safe outside the provider: every call is a no-op there. */
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

const ENTERED_KEY = 'synapse:mascot-entered';

/** Storage can be blocked or throw; without it the entrance simply plays again. */
const hasEntered = (): boolean => {
  try {
    return window.sessionStorage.getItem(ENTERED_KEY) === '1';
  } catch {
    return false;
  }
};

const markEntered = () => {
  try {
    window.sessionStorage.setItem(ENTERED_KEY, '1');
  } catch {
    /* A repeat entrance is the only cost. */
  }
};

/**
 * The entrance plays once per tab, so a logout redirect or a reload after a
 * failed sign-in shows the mascot already in place. It waits above the card
 * while startup config loads, so the drop is not hidden behind the loading blink.
 */
export const entranceFor = (entered: boolean, loading: boolean): MascotEntrance | undefined => {
  if (entered) {
    return undefined;
  }
  return loading ? 'wait' : 'play';
};

/**
 * The brand lockup: the rig, then the wordmark as its own element. The shipped
 * logo files bake both into one SVG, so the icon could not move without
 * dragging the wordmark with it.
 */
export function AuthLockup({
  appTitle,
  loading,
  enter,
}: {
  appTitle: string;
  loading: boolean;
  /** Plays the peekaboo entrance. Only sign-up asks for it: that is where new users meet the mascot. */
  enter: boolean;
}) {
  const localize = useLocalize();
  const { theme } = useTheme();
  const dark = isDark(theme);
  const source = useContext(MascotSourceContext);
  const [entered] = useState(hasEntered);
  const entrance = enter ? entranceFor(entered, loading) : undefined;

  useEffect(() => {
    if (entrance === 'play') {
      markEntered();
    }
  }, [entrance]);

  if (!source) {
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Mascot
        source={source}
        variant={dark ? 'white' : 'teal'}
        entrance={entrance}
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
 * Mirrors a submit into the rig: in flight while `submitting`, then the failed
 * beat if the attempt ends with an error. It fires on a failed submit response,
 * never on field validation — a malformed email should not make the mascot
 * flinch — and it runs alongside the visible error, never instead of it.
 *
 * Arming on each attempt matters: two failed sign-ins produce the same error
 * string, so watching the message alone would show the beat once and then go
 * quiet for every attempt after it.
 */
export function useMascotAttempt(error: unknown, submitting: boolean): void {
  const { setSubmitting, noteFailure } = useMascot();
  const armed = useRef(false);

  useEffect(() => {
    setSubmitting(submitting);
  }, [submitting, setSubmitting]);

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

/**
 * Wraps a registered password field so the mascot looks away while it holds
 * focus. It chains onto react-hook-form's own onBlur; spreading the field after
 * a plain onBlur would silently replace it.
 */
export function withSecretFocus<T extends UseFormRegisterReturn>(
  field: T,
  mascot: MascotController,
): T & { onFocus: () => void } {
  return {
    ...field,
    onFocus: () => mascot.setSecretFocused(true),
    onBlur: (event: FocusEvent<HTMLInputElement>) => {
      mascot.setSecretFocused(false);
      return field.onBlur(event);
    },
  };
}
