import type { MascotSignals } from './pose';
import {
  aimFromPointer,
  nextBlinkDelay,
  isPointerLive,
  resolveBeat,
  targetsFor,
  TIMING,
  GAZE,
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
  it('looks away from the form on the password beat, eyes still open', () => {
    const targets = targetsFor('secret', 0, 0, null);
    expect(targets.gazeX).toBe(-GAZE.maxX);
    expect(targets.lean).toBeLessThan(0);
    expect(targets.arch).toBe(false);
    expect(targets.lidHold).toBe(-1);
  });

  it('shows the resting arch while waking and on success', () => {
    expect(targetsFor('waking', 0, 0, null).arch).toBe(true);
    expect(targetsFor('success', 0, 0, null).arch).toBe(true);
  });

  it('holds the brows back briefly, then raises them', () => {
    expect(targetsFor('failed', 0, 0, null).brow).toBe(false);
    expect(targetsFor('failed', TIMING.browDelayMs + 1, 0, null).brow).toBe(true);
  });

  it('eases the failed beat back out so it ends ready for another attempt', () => {
    const peak = targetsFor('failed', TIMING.failedHoldMs, 0, null);
    const late = targetsFor('failed', TIMING.failedHoldMs + TIMING.failedReleaseMs, 0, null);
    expect(Math.abs(late.drop)).toBeLessThan(Math.abs(peak.drop));
    expect(late.drop).toBeGreaterThan(0);
  });

  it('uses the supplied aim when tracking, and sways when there is none', () => {
    const aimed = targetsFor('tracking', 0, 0, { x: 12, y: -4, lean: 2 });
    expect(aimed.gazeX).toBe(12);
    expect(aimed.lean).toBe(2);
    expect(targetsFor('tracking', 0, 0, null).lean).toBe(0);
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

describe('nextBlinkDelay', () => {
  it('stays inside the idle range, and blinks sooner while busy', () => {
    expect(nextBlinkDelay(false, 0)).toBe(TIMING.blinkMinMs);
    expect(nextBlinkDelay(false, 1)).toBe(TIMING.blinkMaxMs);
    expect(nextBlinkDelay(true, 1)).toBeLessThan(nextBlinkDelay(false, 0));
  });
});
