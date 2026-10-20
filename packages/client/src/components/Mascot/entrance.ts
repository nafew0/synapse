import { blinkCurve, clamp01, easeOut } from './pose';

/**
 * The login entrance: the mark falls in switched off, lands with a thunk,
 * then powers on — the LED flickers, the colour comes up, the eyes boot from
 * a thin line and look left and right before the beat ladder takes over.
 *
 * Pure, like `pose.ts`: elapsed milliseconds in, a pose out, `null` once it
 * has finished.
 */
export interface EntrancePose {
  /** 1 holds the mark a full drop height above its resting place; 0 is landed. */
  height: number;
  /** Positive widens and shortens, as in `MascotTargets`. */
  squash: number;
  /** Strength of the switched-off shade over the shell, 0..1. */
  shade: number;
  led: number;
  /** The lenses stay dark until they boot. */
  lens: number;
  lidWidth: number;
  lid: number;
  gazeX: number;
  gazeY: number;
  /** Progress of the landing puff, or -1 when none is showing. */
  puff: number;
}

export const ENTRANCE = {
  fallMs: 360,
  thunkMs: 70,
  settleMs: 240,
  thunkSquash: 0.1,
  puffMs: 460,
  flickerFromMs: 600,
  flickerStepMs: 38,
  colourFromMs: 900,
  colourMs: 180,
  bootFromMs: 1050,
  bootWidthMs: 120,
  bootOpenFromMs: 1170,
  bootOpenMs: 160,
  blinkAtMs: 1620,
  totalMs: 1750,
  /** The fall starts at the viewport's top edge, kept between these so it never crawls or teleports. */
  minDropPx: 160,
  maxDropPx: 380,
} as const;

const FLICKER = [1, 0, 0, 1, 0, 1, 0.35, 1] as const;

/** A quick check either side before it settles: [from ms, gaze x, gaze y]. */
const LOOK: ReadonlyArray<readonly [number, number, number]> = [
  [1350, -18, 2],
  [1480, 18, 2],
  [1610, 0, 0],
];

const squashAt = (t: number): number => {
  const landed = t - ENTRANCE.fallMs;
  if (landed < 0) {
    return 0;
  }
  if (landed < ENTRANCE.thunkMs) {
    return ENTRANCE.thunkSquash * easeOut(landed / ENTRANCE.thunkMs);
  }
  const settling = landed - ENTRANCE.thunkMs;
  if (settling >= ENTRANCE.settleMs) {
    return 0;
  }
  return ENTRANCE.thunkSquash * Math.exp(-settling / 60) * Math.cos(settling / 34);
};

const ledAt = (t: number): number => {
  if (t < ENTRANCE.flickerFromMs) {
    return 0;
  }
  const step = Math.floor((t - ENTRANCE.flickerFromMs) / ENTRANCE.flickerStepMs);
  return FLICKER[Math.min(FLICKER.length - 1, step)];
};

const lidAt = (t: number): number => {
  if (t < ENTRANCE.bootOpenFromMs) {
    return 0.06;
  }
  const opening = 0.06 + 0.94 * easeOut((t - ENTRANCE.bootOpenFromMs) / ENTRANCE.bootOpenMs);
  return Math.min(opening, blinkCurve(t - ENTRANCE.blinkAtMs));
};

const lookAt = (t: number): readonly [number, number] => {
  const current = LOOK.reduce<readonly [number, number, number] | null>(
    (found, look) => (t >= look[0] ? look : found),
    null,
  );
  return current ? [current[1], current[2]] : [0, 0];
};

export const entrancePose = (t: number): EntrancePose | null => {
  if (t >= ENTRANCE.totalMs) {
    return null;
  }
  const fall = clamp01(t / ENTRANCE.fallMs);
  const [gazeX, gazeY] = lookAt(t);
  const puffing = t >= ENTRANCE.fallMs && t < ENTRANCE.fallMs + ENTRANCE.puffMs;
  return {
    height: t < ENTRANCE.fallMs ? 1 - fall * fall : 0,
    squash: squashAt(t),
    shade: 1 - easeOut((t - ENTRANCE.colourFromMs) / ENTRANCE.colourMs),
    led: ledAt(t),
    lens: t >= ENTRANCE.bootFromMs ? 1 : 0,
    lidWidth: easeOut((t - ENTRANCE.bootFromMs) / ENTRANCE.bootWidthMs),
    lid: lidAt(t),
    gazeX,
    gazeY,
    puff: puffing ? (t - ENTRANCE.fallMs) / ENTRANCE.puffMs : -1,
  };
};

/** The pose held while the page is still loading: above the card, switched off. */
export const ENTRANCE_WAITING: EntrancePose = {
  height: 1,
  squash: 0,
  shade: 1,
  led: 0,
  lens: 0,
  lidWidth: 0,
  lid: 0.06,
  gazeX: 0,
  gazeY: 0,
  puff: -1,
};

/** The fall height in pixels for a mark whose bottom edge sits `bottomPx` below the viewport top. */
export const dropHeightPx = (bottomPx: number): number =>
  Math.min(ENTRANCE.maxDropPx, Math.max(ENTRANCE.minDropPx, bottomPx));
