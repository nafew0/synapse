/**
 * Pose resolution for the auth mascot.
 *
 * Everything here is pure: the component owns the clock, the DOM and the
 * springs' state, this module owns what the mascot should be doing. The beat
 * ladder is ordered and returns on the first match, so a signal can never be
 * blended away by one below it — a moving cursor must not pull the gaze back
 * up while the password field holds focus.
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

/** How often the eyes blink: at rest, while a password is typed, while a submit is in flight. */
export type BlinkPace = 'idle' | 'quick' | 'busy';

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
  /** Eye travel in user units; the rig reaches it on the fast eye spring. */
  gazeX: number;
  gazeY: number;
  /** Head tilt in degrees; the rig reaches it on the slower head spring, so the eyes lead. */
  lean: number;
  /** Body sink in user units, on the body spring. */
  drop: number;
  /** Degrees added to the lean without smoothing, for the wince. */
  shake: number;
  /** User units the body is lifted without smoothing, for the hop. */
  lift: number;
  /** Positive widens and shortens, negative stretches. Applied without smoothing. */
  squash: number;
  eyeScale: number;
  /** -1 lets the lids blink freely; 0..1 holds them at that opening. */
  lidHold: number;
  arch: boolean;
  smile: boolean;
  brow: boolean;
  blinkPace: BlinkPace;
  breathe: boolean;
  /** Steady LED opacity. */
  led: number;
  /** Runs a light up the LED, the one signal that a sign-in is in flight. */
  scan: boolean;
}

/** Aim already resolved against the rendered element, in user units. */
export interface GazeAim {
  x: number;
  y: number;
  lean: number;
}

/** Where the eyes rest between glances when nothing else holds them. */
export interface Glance {
  x: number;
  y: number;
}

export interface SpringState {
  x: number;
  v: number;
}

export interface SpringTuning {
  hz: number;
  damping: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const TIMING = {
  wakeMs: 700,
  typingMs: 1200,
  pointerLingerMs: 1900,
  failedMs: 2800,
  failedHoldMs: 1500,
  browDelayMs: 80,
  flinchMs: 140,
  lidCloseMs: 110,
  lidHoldMs: 40,
  lidOpenMs: 110,
  doubleBlinkGapMs: 70,
  blinkMinMs: 3200,
  blinkMaxMs: 6400,
  blinkQuickMinMs: 900,
  blinkQuickMaxMs: 1800,
  blinkBusyMinMs: 1400,
  blinkBusyMaxMs: 2800,
  /** A keystroke in the password field blinks, but never faster than this. */
  keyBlinkGapMs: 700,
  doubleBlinkChance: 0.22,
  glanceMinMs: 1600,
  glanceMaxMs: 4400,
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
  glanceX: 14,
  glanceMaxY: 10,
} as const;

/** Eyes arrive in about 90ms without overshoot; the head follows with a little. */
export const SPRINGS = {
  eye: { hz: 9, damping: 1 },
  head: { hz: 2.2, damping: 0.55 },
  body: { hz: 3.2, damping: 0.5 },
} as const;

/** A resting breath, not a bob: about 1.5px at the brand panel's size. */
export const BREATH = { hz: 0.22, amp: 8, stretch: 0.008 } as const;

export const HOP = {
  crouchMs: 90,
  airMs: 380,
  landMs: 110,
  crouch: 8,
  height: 60,
  squash: 0.05,
} as const;

export const WINCE = { hz: 2.4, decayMs: 380, amp: 7 } as const;

const BLINK_MS = TIMING.lidCloseMs + TIMING.lidHoldMs + TIMING.lidOpenMs;

const RESTING: MascotTargets = {
  gazeX: 0,
  gazeY: 4,
  lean: 0,
  drop: 0,
  shake: 0,
  lift: 0,
  squash: 0,
  eyeScale: 1,
  lidHold: -1,
  arch: false,
  smile: false,
  brow: false,
  blinkPace: 'idle',
  breathe: true,
  led: 1,
  scan: false,
};

const CENTER_GLANCE: Glance = { x: 0, y: 4 };

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);

/** True while the pointer counts as live: fine pointers only, moved recently. */
export const isPointerLive = (pointer: PointerSample | null, now: number): boolean =>
  pointer !== null && now - pointer.at < TIMING.pointerLingerMs;

/**
 * The ladder. Order is the contract — `secret` must be reachable before
 * anything that could pull the gaze toward the form, and `failed` before the
 * busy state it replaces.
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

/** Crouch, a hop with stretch, a landing squash, then still. */
export const hopAt = (elapsed: number): { lift: number; squash: number } => {
  if (elapsed < HOP.crouchMs) {
    return { lift: -HOP.crouch * easeOut(elapsed / HOP.crouchMs), squash: HOP.squash };
  }
  const air = elapsed - HOP.crouchMs;
  if (air < HOP.airMs) {
    return { lift: HOP.height * Math.sin((Math.PI * air) / HOP.airMs), squash: -HOP.squash };
  }
  const landed = air - HOP.airMs;
  if (landed < HOP.landMs) {
    return { lift: 0, squash: HOP.squash * (1 - landed / HOP.landMs) };
  }
  return { lift: 0, squash: 0 };
};

/** Two head shakes that die away, rather than a buzz. */
const winceAt = (elapsed: number): number =>
  -WINCE.amp *
  Math.sin((elapsed / 1000) * 2 * Math.PI * WINCE.hz) *
  Math.exp(-elapsed / WINCE.decayMs);

const failedTargets = (elapsed: number, aim: GazeAim | null): MascotTargets => {
  const holding = elapsed < TIMING.failedHoldMs;
  return {
    ...RESTING,
    brow: elapsed > TIMING.browDelayMs,
    lean: -3,
    shake: winceAt(elapsed),
    drop: holding ? 10 : 0,
    squash: elapsed < TIMING.flinchMs ? 0.04 : 0,
    gazeX: holding ? -8 : (aim?.x ?? 0),
    gazeY: holding ? 10 : (aim?.y ?? 4),
    lidHold: holding ? 0.55 : -1,
    led: holding ? 0.45 : 1,
  };
};

export const targetsFor = (
  beat: MascotBeat,
  elapsed: number,
  aim: GazeAim | null,
  glance: Glance = CENTER_GLANCE,
): MascotTargets => {
  if (beat === 'secret') {
    return { ...RESTING, smile: true, gazeY: 10, lean: 3, blinkPace: 'quick' };
  }

  if (beat === 'failed') {
    return failedTargets(elapsed, aim);
  }

  if (beat === 'busy') {
    return {
      ...RESTING,
      gazeX: 16,
      gazeY: -14,
      lean: 4,
      lidHold: 0.86,
      blinkPace: 'busy',
      scan: true,
    };
  }

  if (beat === 'success') {
    return { ...RESTING, ...hopAt(elapsed), arch: true, smile: true, gazeY: -2, breathe: false };
  }

  if (beat === 'waking') {
    return { ...RESTING, arch: true, gazeY: 0 };
  }

  if (beat === 'typing') {
    return aim
      ? { ...RESTING, gazeX: aim.x, gazeY: aim.y, lean: aim.lean * 1.3 }
      : { ...RESTING, gazeX: 24, gazeY: 15, lean: 3 };
  }

  if (beat === 'tracking' && aim) {
    return { ...RESTING, gazeX: aim.x, gazeY: aim.y, lean: aim.lean * 1.4 };
  }

  return { ...RESTING, gazeX: glance.x, gazeY: glance.y, lean: glance.x * 0.12 };
};

/**
 * Gaze aim at a viewport point from the rendered box. Deflection grows with
 * distance so a point resting on the mascot leaves it looking straight ahead.
 */
export const aimAt = (x: number, y: number, box: Box): GazeAim => {
  const dx = x - (box.left + box.width * 0.5);
  const dy = y - (box.top + box.height * 0.46);
  const distance = Math.max(1, Math.hypot(dx, dy));
  const reach = Math.min(1, distance / GAZE.reachPx);
  return {
    x: (dx / distance) * GAZE.maxX * reach,
    y: (dy / distance) * GAZE.maxY * reach,
    lean: (dx / distance) * GAZE.maxTilt * reach,
  };
};

export const aimFromPointer = (pointer: PointerSample, box: Box): GazeAim =>
  aimAt(pointer.x, pointer.y, box);

/** Looks at where text starts in a field: its position only, never its contents. */
export const aimAtField = (field: Box, box: Box): GazeAim =>
  aimAt(field.left + field.width * 0.3, field.top + field.height * 0.5, box);

export const nextBlinkDelay = (pace: BlinkPace, roll: number): number => {
  if (pace === 'quick') {
    return TIMING.blinkQuickMinMs + roll * (TIMING.blinkQuickMaxMs - TIMING.blinkQuickMinMs);
  }
  if (pace === 'busy') {
    return TIMING.blinkBusyMinMs + roll * (TIMING.blinkBusyMaxMs - TIMING.blinkBusyMinMs);
  }
  return TIMING.blinkMinMs + roll * (TIMING.blinkMaxMs - TIMING.blinkMinMs);
};

/** Lid opening during one blink, from the moment it started: 1 open, 0.06 shut. */
export const blinkCurve = (elapsed: number): number => {
  if (elapsed < 0 || elapsed >= BLINK_MS) {
    return 1;
  }
  if (elapsed < TIMING.lidCloseMs) {
    return 1 - (elapsed / TIMING.lidCloseMs) * 0.94;
  }
  if (elapsed < TIMING.lidCloseMs + TIMING.lidHoldMs) {
    return 0.06;
  }
  return 0.06 + ((elapsed - TIMING.lidCloseMs - TIMING.lidHoldMs) / TIMING.lidOpenMs) * 0.94;
};

/** When the blink after this one starts: a quick second blink, or the paced gap. */
export const followingBlinkAt = (
  startedAt: number,
  pace: BlinkPace,
  roll: number,
  doubleRoll: number,
): number =>
  doubleRoll < TIMING.doubleBlinkChance
    ? startedAt + BLINK_MS + TIMING.doubleBlinkGapMs
    : startedAt + BLINK_MS + nextBlinkDelay(pace, roll);

export const nextGlance = (rollX: number, rollY: number): Glance => ({
  x: (rollX * 2 - 1) * GAZE.glanceX,
  y: 1 + rollY * (GAZE.glanceMaxY - 1),
});

export const nextGlanceDelay = (roll: number): number =>
  TIMING.glanceMinMs + roll * (TIMING.glanceMaxMs - TIMING.glanceMinMs);

export const breathAt = (seconds: number): number =>
  (Math.sin(seconds * Math.PI * 2 * BREATH.hz) * 0.5 + 0.5) * BREATH.amp;

/** Advances a damped spring by `dt` seconds, in small fixed steps so a long frame stays stable. */
export const stepSpring = (
  state: SpringState,
  target: number,
  tuning: SpringTuning,
  dt: number,
): SpringState => {
  const omega = 2 * Math.PI * tuning.hz;
  const steps = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / steps;
  let { x, v } = state;
  for (let i = 0; i < steps; i++) {
    v += (-omega * omega * (x - target) - 2 * tuning.damping * omega * v) * h;
    x += v * h;
  }
  return { x, v };
};
