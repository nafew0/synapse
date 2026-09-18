/**
 * Pose resolution for the auth mascot.
 *
 * Everything here is pure: the component owns the clock, the DOM and the
 * easing, this module owns what the mascot should be doing. The beat ladder is
 * ordered and returns on the first match, so a signal can never be blended
 * away by one below it — a moving cursor must not re-open the eyes while the
 * password field holds focus.
 */

export type MascotBeat =
  | 'success'
  | 'secret'
  | 'failed'
  | 'busy'
  | 'waking'
  | 'typing'
  | 'tracking'
  | 'resting';

/** A coordinate the pointer last moved to, in viewport pixels. */
export interface PointerSample {
  x: number;
  y: number;
  at: number;
}

/**
 * What the form tells the rig. No field value and no key identity ever appears
 * here — `lastKeyAt` is a timestamp, nothing more.
 */
export interface MascotInput {
  secretFocused: boolean;
  submitting: boolean;
  succeeded: boolean;
  failedAt: number;
  lastKeyAt: number;
}

/**
 * Read once per frame. Keystrokes and pointer moves must not re-render the
 * auth tree, so the rig pulls from a stable source rather than taking props
 * that change many times a second.
 */
export interface MascotInputSource {
  read: () => MascotInput;
}

/** The input plus the two things the rig tracks for itself. */
export interface MascotSignals extends MascotInput {
  pointer: PointerSample | null;
  mountedAt: number;
}

export interface MascotTargets {
  gazeX: number;
  gazeY: number;
  lean: number;
  drop: number;
  shake: number;
  eyeScale: number;
  /** -1 lets the lid blink freely; 0..1 holds it at that opening. */
  lidHold: number;
  /** -1 makes the right lid follow the left. */
  lidHoldRight: number;
  /** Closing from the top edge reads downcast; from the centre reads asleep. */
  lidFromTop: boolean;
  arch: boolean;
  brow: boolean;
  bobHz: number;
  bobAmp: number;
  ledHz: number;
  ledFloor: number;
}

/** Aim already resolved against the rendered element, in user units. */
export interface GazeAim {
  x: number;
  y: number;
  lean: number;
}

export const TIMING = {
  wakeMs: 700,
  typingMs: 1200,
  pointerLingerMs: 1900,
  failedMs: 2800,
  failedOnsetMs: 220,
  failedHoldMs: 1600,
  failedReleaseMs: 1200,
  browDelayMs: 120,
  lidCloseMs: 110,
  lidHoldMs: 40,
  lidOpenMs: 110,
  blinkMinMs: 3200,
  blinkMaxMs: 6400,
  blinkBusyMinMs: 1400,
  blinkBusyMaxMs: 2800,
  doubleBlinkChance: 0.22,
} as const;

/**
 * Travel is capped by the right eye, which has 42 user units of clearance
 * before it leaves the face plate. The head turn does most of the work: 30
 * units is roughly 6px at the size the brand panel renders.
 */
export const GAZE = {
  maxX: 30,
  maxY: 20,
  maxTilt: 4,
  reachPx: 260,
} as const;

const RESTING: MascotTargets = {
  gazeX: 0,
  gazeY: 4,
  lean: 0,
  drop: 0,
  shake: 0,
  eyeScale: 1,
  lidHold: -1,
  lidHoldRight: -1,
  lidFromTop: false,
  arch: false,
  brow: false,
  bobHz: 0.9,
  bobAmp: 6,
  ledHz: 0.55,
  ledFloor: 0.7,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** True while the pointer counts as live: fine pointers only, moved recently. */
export const isPointerLive = (pointer: PointerSample | null, now: number): boolean =>
  pointer !== null && now - pointer.at < TIMING.pointerLingerMs;

/**
 * The ladder. Order is the contract — `secret` must be reachable before
 * anything that could open the eyes, and `failed` before the busy state it
 * replaces.
 */
export const resolveBeat = (signals: MascotSignals, now: number): MascotBeat => {
  if (signals.succeeded) {
    return 'success';
  }
  if (signals.secretFocused) {
    return 'secret';
  }
  if (signals.failedAt > 0 && now - signals.failedAt < TIMING.failedMs) {
    return 'failed';
  }
  if (signals.submitting) {
    return 'busy';
  }
  if (now - signals.mountedAt < TIMING.wakeMs) {
    return 'waking';
  }
  if (now - signals.lastKeyAt < TIMING.typingMs) {
    return 'typing';
  }
  if (isPointerLive(signals.pointer, now)) {
    return 'tracking';
  }
  return 'resting';
};

/**
 * The failed beat rides an envelope — a flinch on impact, then the feeling,
 * then a partial release, so it ends up looking ready for another attempt
 * rather than still upset.
 */
const failedEnvelope = (elapsed: number): number => {
  const onset = clamp01(elapsed / TIMING.failedOnsetMs);
  if (elapsed <= TIMING.failedHoldMs) {
    return onset;
  }
  const released = (elapsed - TIMING.failedHoldMs) / TIMING.failedReleaseMs;
  return onset * Math.max(0.34, 1 - released);
};

export const targetsFor = (
  beat: MascotBeat,
  elapsed: number,
  seconds: number,
  aim: GazeAim | null,
): MascotTargets => {
  if (beat === 'secret') {
    return { ...RESTING, gazeX: -GAZE.maxX, gazeY: 6, lean: -14 };
  }

  if (beat === 'failed') {
    const k = failedEnvelope(elapsed);
    const flinch = Math.exp(-(elapsed / 1000) * 5.5);
    return {
      ...RESTING,
      brow: elapsed > TIMING.browDelayMs,
      shake: Math.sin((elapsed / 1000) * 32) * 4 * flinch,
      lean: -5 * k,
      drop: 5 * k,
      gazeX: -7 * k,
      gazeY: 11 * k,
      bobHz: 1.1,
      bobAmp: 5,
      ledHz: 2.2,
      ledFloor: 0.3,
    };
  }

  if (beat === 'busy') {
    return {
      ...RESTING,
      gazeX: Math.sin(seconds * 2.7) * 24,
      gazeY: 4,
      bobHz: 1.95,
      bobAmp: 3.5,
      ledHz: 2.6,
      ledFloor: 0.3,
    };
  }

  if (beat === 'success') {
    return {
      ...RESTING,
      arch: true,
      gazeX: 0,
      gazeY: 0,
      bobHz: 1.5,
      bobAmp: 9,
      ledHz: 0,
      ledFloor: 1,
    };
  }

  if (beat === 'waking') {
    return { ...RESTING, arch: true, gazeX: 0, gazeY: 0 };
  }

  if (beat === 'typing') {
    return { ...RESTING, gazeX: 24, gazeY: 15, lean: 3 };
  }

  if (beat === 'tracking' && aim) {
    return { ...RESTING, gazeX: aim.x, gazeY: aim.y, lean: aim.lean };
  }

  return { ...RESTING, gazeX: Math.sin(seconds * 0.6) * 10 };
};

/**
 * Gaze aim from a pointer position and the rendered box. Deflection grows with
 * distance so a cursor resting on the mascot leaves it looking straight ahead.
 */
export const aimFromPointer = (
  pointer: PointerSample,
  box: { left: number; top: number; width: number; height: number },
): GazeAim => {
  const cx = box.left + box.width * 0.5;
  const cy = box.top + box.height * 0.46;
  const dx = pointer.x - cx;
  const dy = pointer.y - cy;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const reach = Math.min(1, distance / GAZE.reachPx);
  return {
    x: (dx / distance) * GAZE.maxX * reach,
    y: (dy / distance) * GAZE.maxY * reach,
    lean: (dx / distance) * GAZE.maxTilt * reach,
  };
};

export const nextBlinkDelay = (busy: boolean, roll: number): number => {
  const min = busy ? TIMING.blinkBusyMinMs : TIMING.blinkMinMs;
  const max = busy ? TIMING.blinkBusyMaxMs : TIMING.blinkMaxMs;
  return min + roll * (max - min);
};
