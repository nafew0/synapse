import type { MascotSignals } from './pose';
import {
  followingBlinkAt,
  nextGlanceDelay,
  aimFromPointer,
  nextBlinkDelay,
  isPointerLive,
  resolveBeat,
  targetsFor,
  aimAtField,
  stepSpring,
  blinkCurve,
  nextGlance,
  breathAt,
  SPRINGS,
  BREATH,
  TIMING,
  GAZE,
  HOP,
} from './pose';

const NOW = 100_000;

const signals = (overrides: Partial<MascotSignals> = {}): MascotSignals => ({
  secretFocused: false,
  submitting: false,
  succeeded: false,
  failedAt: 0,
  lastKeyAt: 0,
  pointer: null,
  mountedAt: NOW - TIMING.wakeMs - 1,
  ...overrides,
});

const livePointer = { x: 900, y: 400, at: NOW - 100 };

describe('resolveBeat', () => {
  it('rests when nothing is happening', () => {
    expect(resolveBeat(signals(), NOW)).toBe('resting');
  });

  it('wakes for the first 700ms after mount, then rests', () => {
    expect(resolveBeat(signals({ mountedAt: NOW - 200 }), NOW)).toBe('waking');
    expect(resolveBeat(signals({ mountedAt: NOW - TIMING.wakeMs }), NOW)).toBe('resting');
  });

  it('follows the pointer while it is live, and stops once it goes stale', () => {
    expect(resolveBeat(signals({ pointer: livePointer }), NOW)).toBe('tracking');
    const stale = { x: 900, y: 400, at: NOW - TIMING.pointerLingerMs };
    expect(resolveBeat(signals({ pointer: stale }), NOW)).toBe('resting');
  });

  it('watches the field while keys are landing, and hands back to the cursor after', () => {
    const typing = signals({ lastKeyAt: NOW - 200, pointer: livePointer });
    expect(resolveBeat(typing, NOW)).toBe('typing');

    const paused = signals({ lastKeyAt: NOW - TIMING.typingMs, pointer: livePointer });
    expect(resolveBeat(paused, NOW)).toBe('tracking');
  });

  /** The ordering is the whole point of the ladder, so pin each rank. */
  describe('precedence', () => {
    it('lets password focus outrank a moving cursor and active typing', () => {
      const beat = resolveBeat(
        signals({ secretFocused: true, lastKeyAt: NOW - 10, pointer: livePointer }),
        NOW,
      );
      expect(beat).toBe('secret');
    });

    it('lets password focus outrank an in-flight submit', () => {
      expect(resolveBeat(signals({ secretFocused: true, submitting: true }), NOW)).toBe('secret');
    });

    it('lets a failed attempt outrank typing and the pointer', () => {
      const beat = resolveBeat(
        signals({ failedAt: NOW - 500, lastKeyAt: NOW - 10, pointer: livePointer }),
        NOW,
      );
      expect(beat).toBe('failed');
    });

    it('releases the failed beat once it has run its course', () => {
      expect(resolveBeat(signals({ failedAt: NOW - TIMING.failedMs }), NOW)).toBe('resting');
    });

    it('lets an in-flight submit outrank typing', () => {
      expect(resolveBeat(signals({ submitting: true, lastKeyAt: NOW - 10 }), NOW)).toBe('busy');
    });

    it('lets success outrank everything, including password focus', () => {
      const beat = resolveBeat(
        signals({ succeeded: true, secretFocused: true, submitting: true, failedAt: NOW - 10 }),
        NOW,
      );
      expect(beat).toBe('success');
    });
  });
});

describe('targetsFor', () => {
  it('smiles on the password beat, eyes open and blinking quickly, looking down', () => {
    const targets = targetsFor('secret', 0, { x: 30, y: 0, lean: 4 });
    expect(targets.smile).toBe(true);
    expect(targets.grin).toBe(false);
    expect(targets.cheek).toBeGreaterThan(0);
    expect(targets.blush).toBeGreaterThan(0);
    expect(targets.arch).toBe(false);
    expect(targets.lidHold).toBe(-1);
    expect(targets.blinkPace).toBe('quick');
    expect(targets.gazeX).toBe(0);
    expect(targets.gazeY).toBeGreaterThan(0);
  });

  it('shows the resting arch while waking, and grins with happy eyes on success', () => {
    expect(targetsFor('waking', 0, null).arch).toBe(true);
    const success = targetsFor('success', 0, null);
    expect(success.grin).toBe(true);
    expect(success.blush).toBe(1);
    expect(success.arch).toBe(false);
  });

  it('hops on success: crouches, rises, lands, then stands still', () => {
    expect(targetsFor('success', HOP.crouchMs / 2, null).lift).toBeLessThan(0);
    expect(targetsFor('success', HOP.crouchMs + HOP.airMs / 2, null).lift).toBeCloseTo(HOP.height);
    const settled = targetsFor('success', HOP.crouchMs + HOP.airMs + HOP.landMs, null);
    expect(settled.lift).toBe(0);
    expect(settled.squash).toBe(0);
  });

  it('holds the brows back briefly, then raises them', () => {
    expect(targetsFor('failed', 0, null).brow).toBe(false);
    expect(targetsFor('failed', TIMING.browDelayMs + 1, null).brow).toBe(true);
  });

  it('squints and dims the LED after a failure, then looks back at the field', () => {
    const field = { x: 20, y: 12, lean: 3 };
    const holding = targetsFor('failed', TIMING.failedHoldMs - 1, field);
    expect(holding.lidHold).toBeLessThan(1);
    expect(holding.led).toBeLessThan(1);
    const released = targetsFor('failed', TIMING.failedHoldMs, field);
    expect(released.lidHold).toBe(-1);
    expect(released.gazeX).toBe(field.x);
    expect(released.drop).toBe(0);
  });

  it('shakes its head and settles, rather than buzzing', () => {
    expect(Math.abs(targetsFor('failed', 100, null).shake)).toBeGreaterThan(1);
    expect(Math.abs(targetsFor('failed', 2000, null).shake)).toBeLessThan(0.05);
  });

  it('keeps the LED steady except while a sign-in is in flight', () => {
    expect(targetsFor('resting', 0, null).scan).toBe(false);
    expect(targetsFor('resting', 0, null).led).toBe(1);
    expect(targetsFor('busy', 0, null).scan).toBe(true);
  });

  it('looks at the focused field while typing, and at the form side without one', () => {
    expect(targetsFor('typing', 0, { x: -10, y: 6, lean: -2 }).gazeX).toBe(-10);
    expect(targetsFor('typing', 0, null).gazeX).toBeGreaterThan(0);
  });

  it('uses the supplied aim when tracking, and rests on its glance when there is none', () => {
    expect(targetsFor('tracking', 0, { x: 12, y: -4, lean: 2 }).gazeX).toBe(12);
    const glancing = targetsFor('tracking', 0, null, { x: 9, y: 3 });
    expect(glancing.gazeX).toBe(9);
    expect(glancing.gazeY).toBe(3);
  });
});

describe('aimFromPointer', () => {
  const box = { left: 0, top: 0, width: 200, height: 200 };

  it('never sends an eye further than the face plate allows', () => {
    const far = aimFromPointer({ x: 5000, y: 5000, at: 0 }, box);
    expect(Math.abs(far.x)).toBeLessThanOrEqual(GAZE.maxX);
    expect(Math.abs(far.y)).toBeLessThanOrEqual(GAZE.maxY);
    expect(Math.abs(far.lean)).toBeLessThanOrEqual(GAZE.maxTilt);
  });

  it('deflects further as the pointer moves away', () => {
    const near = aimFromPointer({ x: 140, y: 92, at: 0 }, box);
    const far = aimFromPointer({ x: 600, y: 92, at: 0 }, box);
    expect(Math.abs(far.x)).toBeGreaterThan(Math.abs(near.x));
  });

  it('turns the head the same way it turns the eyes', () => {
    const right = aimFromPointer({ x: 800, y: 92, at: 0 }, box);
    const left = aimFromPointer({ x: -800, y: 92, at: 0 }, box);
    expect(Math.sign(right.lean)).toBe(Math.sign(right.x));
    expect(Math.sign(left.lean)).toBe(Math.sign(left.x));
  });
});

describe('isPointerLive', () => {
  it('is false without a pointer, and false once the sample goes stale', () => {
    expect(isPointerLive(null, NOW)).toBe(false);
    expect(isPointerLive({ x: 0, y: 0, at: NOW - TIMING.pointerLingerMs }, NOW)).toBe(false);
    expect(isPointerLive({ x: 0, y: 0, at: NOW - 10 }, NOW)).toBe(true);
  });
});

describe('aimAtField', () => {
  it('turns toward a field to the right and below', () => {
    const field = { left: 600, top: 300, width: 300, height: 40 };
    const aim = aimAtField(field, { left: 0, top: 0, width: 200, height: 200 });
    expect(aim.x).toBeGreaterThan(0);
    expect(aim.y).toBeGreaterThan(0);
  });
});

describe('blinking', () => {
  const blinkMs = TIMING.lidCloseMs + TIMING.lidHoldMs + TIMING.lidOpenMs;

  it('blinks quickest while a password is typed and slowest at rest', () => {
    expect(nextBlinkDelay('idle', 0)).toBe(TIMING.blinkMinMs);
    expect(nextBlinkDelay('idle', 1)).toBe(TIMING.blinkMaxMs);
    expect(nextBlinkDelay('quick', 1)).toBeLessThan(nextBlinkDelay('busy', 1));
    expect(nextBlinkDelay('busy', 1)).toBeLessThan(nextBlinkDelay('idle', 0));
  });

  it('closes, holds and reopens within one blink', () => {
    expect(blinkCurve(-1)).toBe(1);
    expect(blinkCurve(TIMING.lidCloseMs + 1)).toBeCloseTo(0.06);
    expect(blinkCurve(blinkMs)).toBe(1);
  });

  it('sometimes follows straight on with a second blink', () => {
    expect(followingBlinkAt(0, 'idle', 0, 0)).toBe(blinkMs + TIMING.doubleBlinkGapMs);
    expect(followingBlinkAt(0, 'idle', 0, 1)).toBe(blinkMs + TIMING.blinkMinMs);
  });
});

describe('glances and breath', () => {
  it('keeps resting glances inside the face', () => {
    for (const roll of [0, 0.5, 1]) {
      const glance = nextGlance(roll, roll);
      expect(Math.abs(glance.x)).toBeLessThanOrEqual(GAZE.glanceX);
      expect(glance.y).toBeGreaterThanOrEqual(1);
      expect(glance.y).toBeLessThanOrEqual(GAZE.glanceMaxY);
    }
    expect(nextGlanceDelay(0)).toBe(TIMING.glanceMinMs);
    expect(nextGlanceDelay(1)).toBe(TIMING.glanceMaxMs);
  });

  it('breathes within its amplitude', () => {
    const samples = Array.from({ length: 50 }, (_, i) => breathAt(i / 10));
    expect(Math.max(...samples)).toBeLessThanOrEqual(BREATH.amp);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
  });
});

describe('stepSpring', () => {
  const run = (tuning: { hz: number; damping: number }, frames: number) => {
    let state = { x: 0, v: 0 };
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      state = stepSpring(state, 10, tuning, 1 / 60);
      peak = Math.max(peak, state.x);
    }
    return { state, peak };
  };

  it('brings the eyes to their target within a few frames and never past it', () => {
    const { state, peak } = run(SPRINGS.eye, 12);
    expect(state.x).toBeCloseTo(10, 0);
    expect(peak).toBeLessThanOrEqual(10.001);
  });

  it('lets the head overshoot a little, then settle', () => {
    const { state, peak } = run(SPRINGS.head, 120);
    expect(peak).toBeGreaterThan(10);
    expect(state.x).toBeCloseTo(10, 1);
  });

  it('stays stable through a long frame', () => {
    const state = stepSpring({ x: 0, v: 0 }, 10, SPRINGS.eye, 0.064);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(state.x).toBeLessThanOrEqual(10.001);
  });
});
