import { blinkCurve, clamp01, easeOut } from './pose';

/**
 * The sign-up entrance, peekaboo: the mark rises from behind the ground line
 * until its eyes clear it, looks left and right, ducks, then leaps up onto its
 * spot with a grin and lands with a squash and a puff.
 *
 * Pure, like `pose.ts`: elapsed milliseconds in, a pose out, `null` once it
 * has finished. Distances are user units of the mark, positive downward.
 */
export interface EntrancePose {
  /** How far below its resting place the mark sits; the ground line hides what falls under it. */
  drop: number;
  rotate: number;
  /** Positive widens and shortens, negative stretches, as in `MascotTargets`. */
  squash: number;
  gazeX: number;
  gazeY: number;
  lid: number;
  eyeScale: number;
  /** 0..1: the open grin with happy closed eyes and blush. */
  grin: number;
  /** Shadow strength, 0 while the mark is behind the ground line. */
  shadow: number;
  /** Progress of the landing puff, or -1 when none is showing. */
  puff: number;
}

export const ENTRANCE = {
  riseFromMs: 250,
  riseMs: 400,
  lookRightAtMs: 1050,
  blinkAtMs: 1180,
  duckFromMs: 1450,
  duckMs: 170,
  leapFromMs: 1800,
  leapMs: 350,
  fallMs: 270,
  landMs: 90,
  grinFromMs: 1900,
  grinMs: 150,
  grinFadeFromMs: 2600,
  grinFadeMs: 250,
  puffMs: 460,
  totalMs: 2850,
  /** Below this the mark is hidden: just under its feet, so the resting pose is never clipped. */
  groundY: 720,
  hiddenDrop: 740,
  /** Leaves the top of the head and the eyes above the ground line. */
  peekDrop: 277,
  duckDrop: 650,
  leapHeight: 520,
  peekGlance: 26,
  peekTilt: 5,
  landSquash: 0.2,
} as const;

const LAND_AT = ENTRANCE.leapFromMs + ENTRANCE.leapMs + ENTRANCE.fallMs;

const ramp = (t: number, from: number, length: number): number => clamp01((t - from) / length);

const lerp = (from: number, to: number, k: number): number => from + (to - from) * k;

const easeIn = (t: number): number => Math.pow(clamp01(t), 2);

const easeOutBack = (t: number): number => {
  const k = clamp01(t) - 1;
  return 1 + 2.7 * k * k * k + 1.7 * k * k;
};

const HIDDEN: EntrancePose = {
  drop: ENTRANCE.hiddenDrop,
  rotate: 0,
  squash: 0,
  gazeX: 0,
  gazeY: 4,
  lid: 1,
  eyeScale: 1,
  grin: 0,
  shadow: 0,
  puff: -1,
};

const peeking = (t: number): EntrancePose => {
  const left = t < ENTRANCE.lookRightAtMs;
  return {
    ...HIDDEN,
    drop: ENTRANCE.peekDrop,
    gazeX: left ? -ENTRANCE.peekGlance : ENTRANCE.peekGlance,
    gazeY: 2,
    rotate: left ? -ENTRANCE.peekTilt : ENTRANCE.peekTilt,
    lid: blinkCurve(t - ENTRANCE.blinkAtMs),
  };
};

const leaping = (t: number): EntrancePose => {
  const k = easeOut(ramp(t, ENTRANCE.leapFromMs, ENTRANCE.leapMs));
  const grin = ramp(t, ENTRANCE.grinFromMs, ENTRANCE.grinMs);
  return {
    ...HIDDEN,
    drop: lerp(ENTRANCE.duckDrop, -ENTRANCE.leapHeight, k),
    squash: -0.1 * (1 - k),
    gazeY: -4,
    eyeScale: 1 + 0.14 * (1 - grin),
    grin,
    shadow: 0.6 * k,
  };
};

const falling = (t: number): EntrancePose => {
  const k = easeIn(ramp(t, ENTRANCE.leapFromMs + ENTRANCE.leapMs, ENTRANCE.fallMs));
  return {
    ...HIDDEN,
    drop: lerp(-ENTRANCE.leapHeight, 0, k),
    squash: -0.06 * k,
    gazeY: 2,
    grin: 1,
    shadow: 0.6 + 0.4 * k,
  };
};

const landed = (t: number): EntrancePose => {
  const since = t - LAND_AT;
  const squash =
    since < ENTRANCE.landMs
      ? ENTRANCE.landSquash * Math.sin(Math.PI * (since / ENTRANCE.landMs))
      : 0.05 * Math.exp(-(since - ENTRANCE.landMs) / 70) * Math.cos((since - ENTRANCE.landMs) / 36);
  return {
    ...HIDDEN,
    drop: 0,
    squash,
    gazeY: 2,
    grin: 1 - ramp(t, ENTRANCE.grinFadeFromMs, ENTRANCE.grinFadeMs),
    shadow: 1,
    puff: since < ENTRANCE.puffMs ? since / ENTRANCE.puffMs : -1,
  };
};

export const entrancePose = (t: number): EntrancePose | null => {
  if (t >= ENTRANCE.totalMs) {
    return null;
  }
  if (t < ENTRANCE.riseFromMs) {
    return HIDDEN;
  }
  if (t < ENTRANCE.riseFromMs + ENTRANCE.riseMs) {
    const k = easeOutBack(ramp(t, ENTRANCE.riseFromMs, ENTRANCE.riseMs));
    return { ...HIDDEN, drop: lerp(ENTRANCE.hiddenDrop, ENTRANCE.peekDrop, k), gazeY: 2 };
  }
  if (t < ENTRANCE.duckFromMs) {
    return peeking(t);
  }
  if (t < ENTRANCE.leapFromMs) {
    const k = easeIn(ramp(t, ENTRANCE.duckFromMs, ENTRANCE.duckMs));
    return { ...HIDDEN, drop: lerp(ENTRANCE.peekDrop, ENTRANCE.duckDrop, k) };
  }
  if (t < ENTRANCE.leapFromMs + ENTRANCE.leapMs) {
    return leaping(t);
  }
  if (t < LAND_AT) {
    return falling(t);
  }
  return landed(t);
};

/** The pose held while the page is still loading: out of sight behind the ground line. */
export const ENTRANCE_WAITING: EntrancePose = HIDDEN;
