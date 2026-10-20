import React, { useRef, useLayoutEffect } from 'react';
import type {
  MascotInputSource,
  PointerSample,
  MascotSignals,
  MascotInput,
  SpringState,
  MascotBeat,
  BlinkPace,
  GazeAim,
  Glance,
  Box,
} from './pose';
import type { EntrancePose } from './entrance';
import {
  followingBlinkAt,
  nextGlanceDelay,
  aimFromPointer,
  resolveBeat,
  targetsFor,
  stepSpring,
  aimAtField,
  blinkCurve,
  nextGlance,
  breathAt,
  SPRINGS,
  BREATH,
  TIMING,
} from './pose';
import { entrancePose, dropHeightPx, ENTRANCE_WAITING } from './entrance';

/**
 * The shell, face plate and status pill are the unmodified geometry of
 * `icon_synapse_v1.svg`. The eyes, brows and smile are the additions: the mark
 * ships with the resting arch, which the rig treats as its closed pose.
 */
const BODY =
  'M.33,419.41,32.54,181.28S52.2,4.1,250.27,0C451.11,25.69,497.16,32.07,497.16,32.07s80.71,2.36,145.45,92.21c51,67.26,37,152.45,37,152.45q-1.41,10.36-2.83,20.73-2.53,10.23-5,20.46a115.78,115.78,0,0,1-6,15.5c-2.7,5.74-3.72,6.64-7.4,14.44s-4.84,11.53-5.53,15a35.07,35.07,0,0,0-.86,8.77c.2,5,1.56,9,2.88,12.88,1.1,3.24,1.46,3.5,3,7.89a52.25,52.25,0,0,1,2.25,7.57c.55,3.37.34,6.21-.07,11.87-.11,1.46-.23,2.67-.33,4.89-.15,3.11-.07,4.14-.53,8.23-.37,3.22-.94,8-1.71,13.84-4.32,32.22-6.95,82.43-26.26,116.88C616.47,581.93,567,689.25,414,680.69,288.2,668.21,167.54,646,167.54,646S-8.68,607.06.33,419.41Z';
const ARCH_LEFT =
  'M410.78,310.42l0,.12a6.62,6.62,0,0,1-10.23,4.58A63.36,63.36,0,0,0,347,307.78a6.62,6.62,0,0,1-8.63-7.17l0-.11c3.29-24,22.16-41.25,42.15-38.51S414.07,286.42,410.78,310.42Z';
const ARCH_RIGHT =
  'M510.26,326.64l0,.1c-.6,4.42,2.89,7.79,6.46,6.33a41.31,41.31,0,0,1,40.81,5.6c3,2.36,7.31.05,7.92-4.36l0-.11c3-21.85-6.93-41.25-22.17-43.34S513.25,304.78,510.26,326.64Z';
/** Sits under the gap between the eyes and follows their tilt, so it reads in the same three-quarter view. */
const SMILE = 'M408,362 Q441,398 482,373';

/** 140 units of side room for the lean, 80 of headroom for the breath and hop. */
const VIEW_BOX = '-140 -80 961.39 791.17';
const VIEW_WIDTH = 961.39;
const PUFF_COUNT = 6;
const SCAN_HZ = 1.1;

export type MascotEntrance = 'wait' | 'play';

type LockupVariant = 'teal' | 'white';

interface LockupPaint {
  shell: string;
  face: string;
  lens: string;
  glint: string;
  glintOpacity: number;
  arch: string;
  pill: string;
  shade: string;
  ground: string;
  groundOpacity: number;
  puff: string;
  scan: string;
}

/** Matches `logo_bdren_v1.svg` and `logo_white.svg` exactly, including the
 *  inverted eye contrast the white lockup uses. */
const PAINT: Record<LockupVariant, LockupPaint> = {
  teal: {
    shell: 'url(#synapse-mascot-shell)',
    face: '#F8F3EC',
    lens: 'url(#synapse-mascot-lens)',
    glint: '#F8F3EC',
    glintOpacity: 0.8,
    arch: '#186569',
    pill: '#F47948',
    shade: '#1B2A2B',
    ground: '#134F54',
    groundOpacity: 0.24,
    puff: '#328A8A',
    scan: '#FFF3EA',
  },
  white: {
    shell: '#FFFFFF',
    face: '#D2D2D1',
    lens: '#FFFFFF',
    glint: '#BFBFBE',
    glintOpacity: 0.75,
    arch: '#FFFFFF',
    pill: '#F47948',
    shade: '#3D4A4B',
    ground: '#000000',
    groundOpacity: 0.45,
    puff: '#FFFFFF',
    scan: '#FFFFFF',
  },
};

export interface MascotProps {
  /** Read once per frame; keystrokes must not re-render the tree. */
  source: MascotInputSource;
  variant?: LockupVariant;
  /**
   * `wait` holds the mark above the card, switched off; `play` drops it in and
   * powers it on. Leave it out to start in place. Read every frame, so it can
   * move from `wait` to `play` once the page has loaded.
   */
  entrance?: MascotEntrance;
  className?: string;
  title?: string;
}

/** Everything the paint step writes, in user units and opacities. */
interface Frame {
  y: number;
  rotate: number;
  squash: number;
  stretch: number;
  shade: number;
  gazeX: number;
  gazeY: number;
  eyeScale: number;
  lid: number;
  lidWidth: number;
  lens: number;
  arch: number;
  smile: number;
  brow: number;
  led: number;
  /** Phase of the LED scan, 0..1, or -1 when off. */
  scan: number;
  /** How far above the ground the body is, for the shadow. */
  airborne: number;
  /** Progress of the landing puff, or -1 when none is showing. */
  puff: number;
}

interface RigState {
  gazeX: SpringState;
  gazeY: SpringState;
  lean: SpringState;
  drop: SpringState;
  eyeScale: number;
  arch: number;
  smile: number;
  brow: number;
  led: number;
  lid: number;
  blinkFrom: number;
  blinkAt: number;
  lastKeySeen: number;
  glance: Glance;
  glanceAt: number;
  beat: MascotBeat | '';
  beatAt: number;
}

type EntranceState = { phase: 'none' } | { phase: 'waiting' } | { phase: 'playing'; at: number };

interface Parts {
  rig: SVGElement;
  shade: SVGElement;
  gaze: SVGElement;
  lids: SVGElement[];
  glints: SVGElement[];
  arch: SVGElement;
  brow: SVGElement;
  mouth: SVGElement;
  pill: SVGElement;
  scan: SVGElement;
  scanStops: SVGElement[];
  ground: SVGElement;
  puffs: SVGElement[];
}

const approach = (value: number, target: number, rate: number): number =>
  value + (target - value) * Math.min(1, rate);

const n2 = (value: number): string => value.toFixed(2);

const focusedField = (): Element | null => {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? active
    : null;
};

/** The pointer when following it, the focused field when typing or recovering; never a value. */
const aimFor = (beat: MascotBeat, pointer: PointerSample | null, box: Box): GazeAim | null => {
  if (beat === 'tracking' && pointer) {
    return aimFromPointer(pointer, box);
  }
  if (beat !== 'typing' && beat !== 'failed') {
    return null;
  }
  const field = focusedField();
  return field ? aimAtField(field.getBoundingClientRect(), box) : null;
};

const queryParts = (root: SVGSVGElement): Parts => {
  const one = (name: string) => root.querySelector(`[data-part="${name}"]`) as SVGElement;
  const all = (name: string) =>
    Array.from(root.querySelectorAll(`[data-part="${name}"]`)) as SVGElement[];
  return {
    rig: one('rig'),
    shade: one('shade'),
    gaze: one('gaze'),
    lids: [one('lid-left'), one('lid-right')],
    glints: all('glint'),
    arch: one('arch'),
    brow: one('brow'),
    mouth: one('mouth'),
    pill: one('pill'),
    scan: one('scan'),
    scanStops: all('scan-stop'),
    ground: one('ground'),
    puffs: all('puff'),
  };
};

const paintPuffs = (puffs: SVGElement[], progress: number) => {
  puffs.forEach((puff, i) => {
    if (progress < 0) {
      puff.style.opacity = '0';
      return;
    }
    const ring = i >> 1;
    const side = i % 2 === 0 ? -1 : 1;
    const k = 1 - Math.pow(1 - progress, 3);
    const x = side * (120 + ring * 90) * k;
    const y = -(30 + ring * 28) * k;
    const scale = 0.4 + (0.6 + ring * 0.35) * progress;
    puff.style.transform = `translate(${n2(x)}px,${n2(y)}px) scale(${scale.toFixed(3)})`;
    puff.style.opacity = (0.9 * (1 - progress)).toFixed(3);
  });
};

const paint = (parts: Parts, frame: Frame, groundOpacity: number) => {
  parts.rig.style.transform =
    `translate(0px,${n2(frame.y)}px) rotate(${n2(frame.rotate)}deg) ` +
    `scale(${(1 + frame.squash * 0.7).toFixed(4)},${(1 - frame.squash + frame.stretch).toFixed(4)})`;
  parts.shade.style.opacity = (frame.shade * 0.85).toFixed(3);
  parts.gaze.style.transform = `translate(${n2(frame.gazeX)}px,${n2(frame.gazeY)}px) scale(${frame.eyeScale.toFixed(3)})`;

  const lens = (frame.lens * (1 - frame.arch)).toFixed(3);
  const lid = `scale(${Math.max(0.02, frame.lidWidth).toFixed(3)},${Math.max(0.02, frame.lid).toFixed(3)})`;
  for (const part of parts.lids) {
    part.style.transform = lid;
    part.style.opacity = lens;
  }
  const glint = `translate(${n2(-0.4 * frame.gazeX)}px,${n2(-0.4 * frame.gazeY)}px)`;
  for (const part of parts.glints) {
    part.style.transform = glint;
  }

  parts.arch.style.opacity = frame.arch.toFixed(3);
  parts.brow.style.opacity = frame.brow.toFixed(3);
  parts.brow.style.transform = `translateY(${n2((1 - frame.brow) * -16)}px)`;
  parts.mouth.style.opacity = frame.smile.toFixed(3);
  parts.mouth.style.transform =
    `translate(${n2(frame.gazeX * 0.35)}px,${n2(frame.gazeY * 0.35)}px) ` +
    `scaleY(${(0.2 + 0.8 * frame.smile).toFixed(3)})`;
  parts.pill.style.opacity = frame.led.toFixed(3);

  if (frame.scan < 0) {
    parts.scan.style.opacity = '0';
  } else {
    parts.scan.style.opacity = '1';
    const head = -0.25 + frame.scan * 1.5;
    parts.scanStops.forEach((stop, i) => {
      stop.setAttribute('offset', Math.min(1, Math.max(0, head + (i - 1) * 0.22)).toFixed(3));
    });
  }

  const lifted = Math.min(1, frame.airborne / 1300);
  parts.ground.style.transform = `scale(${((1 - lifted * 0.65) * (1 + frame.squash * 0.7)).toFixed(3)},${(1 - lifted * 0.5).toFixed(3)})`;
  parts.ground.style.opacity = (groundOpacity * (1 - lifted * 0.85)).toFixed(3);
  paintPuffs(parts.puffs, frame.puff);
};

const STILL: Omit<Frame, 'arch' | 'smile' | 'brow' | 'led'> = {
  y: 0,
  rotate: 0,
  squash: 0,
  stretch: 0,
  shade: 0,
  gazeX: 0,
  gazeY: 4,
  eyeScale: 1,
  lid: 1,
  lidWidth: 1,
  lens: 1,
  scan: -1,
  airborne: 0,
  puff: -1,
};

const entranceFrame = (pose: EntrancePose, rig: RigState, dt: number, dropUnits: number): Frame => {
  rig.gazeX = stepSpring(rig.gazeX, pose.gazeX, SPRINGS.eye, dt);
  rig.gazeY = stepSpring(rig.gazeY, pose.gazeY, SPRINGS.eye, dt);
  rig.lid = pose.lid;
  rig.led = pose.led;
  rig.arch = 0;
  return {
    ...STILL,
    y: -pose.height * dropUnits,
    squash: pose.squash,
    shade: pose.shade,
    gazeX: rig.gazeX.x,
    gazeY: rig.gazeY.x,
    lid: pose.lid,
    lidWidth: pose.lidWidth,
    lens: pose.lens,
    arch: 0,
    smile: 0,
    brow: 0,
    led: pose.led,
    airborne: pose.height * dropUnits,
    puff: pose.puff,
  };
};

/** Reduced motion: nothing moves, but every state still reads by crossfade. */
const stillFrame = (beat: MascotBeat, rig: RigState, dt: number): Frame => {
  rig.arch = approach(rig.arch, beat === 'waking' || beat === 'success' ? 1 : 0, dt * 6);
  rig.smile = approach(rig.smile, beat === 'secret' || beat === 'success' ? 1 : 0, dt * 6);
  rig.brow = approach(rig.brow, beat === 'failed' ? 1 : 0, dt * 6);
  rig.led = approach(rig.led, beat === 'busy' ? 0.45 : 1, dt * 6);
  return { ...STILL, arch: rig.arch, smile: rig.smile, brow: rig.brow, led: rig.led };
};

const startBlink = (rig: RigState, now: number, pace: BlinkPace) => {
  rig.blinkFrom = now;
  rig.blinkAt = followingBlinkAt(now, pace, Math.random(), Math.random());
};

/** Lids for the ladder: held open by the arch, held at a level, or blinking at the beat's pace. */
const stepLids = (
  rig: RigState,
  now: number,
  dt: number,
  beat: MascotBeat,
  input: MascotInput,
  lidHold: number,
  pace: BlinkPace,
): number => {
  if (lidHold >= 0) {
    rig.lid = approach(rig.lid, lidHold, dt * 9);
    return rig.lid;
  }
  const keyed = input.lastKeyAt > rig.lastKeySeen;
  rig.lastKeySeen = input.lastKeyAt;
  if (beat === 'secret' && keyed && now - rig.blinkFrom > TIMING.keyBlinkGapMs) {
    startBlink(rig, now, pace);
  } else if (now >= rig.blinkAt) {
    startBlink(rig, now, pace);
  }
  rig.lid = Math.min(blinkCurve(now - rig.blinkFrom), approach(rig.lid, 1, dt * 12));
  return rig.lid;
};

const ladderFrame = (
  signals: MascotSignals,
  rig: RigState,
  now: number,
  dt: number,
  box: Box,
): Frame => {
  const beat = resolveBeat(signals, now);
  if (beat !== rig.beat) {
    rig.beat = beat;
    rig.beatAt = now;
  }
  if (now >= rig.glanceAt) {
    rig.glance = nextGlance(Math.random(), Math.random());
    rig.glanceAt = now + nextGlanceDelay(Math.random());
  }

  const targets = targetsFor(
    beat,
    now - rig.beatAt,
    aimFor(beat, signals.pointer, box),
    rig.glance,
  );
  rig.gazeX = stepSpring(rig.gazeX, targets.gazeX, SPRINGS.eye, dt);
  rig.gazeY = stepSpring(rig.gazeY, targets.gazeY, SPRINGS.eye, dt);
  rig.lean = stepSpring(rig.lean, targets.lean, SPRINGS.head, dt);
  rig.drop = stepSpring(rig.drop, targets.drop, SPRINGS.body, dt);
  rig.eyeScale = approach(rig.eyeScale, targets.eyeScale, dt * 4.5);
  rig.arch = approach(rig.arch, targets.arch ? 1 : 0, dt * 10);
  rig.smile = approach(rig.smile, targets.smile ? 1 : 0, dt * 8);
  rig.brow = approach(rig.brow, targets.brow ? 1 : 0, dt * 8);
  rig.led = approach(rig.led, targets.led, dt * 6);

  const lid = targets.arch
    ? 1
    : stepLids(rig, now, dt, beat, signals, targets.lidHold, targets.blinkPace);
  const breath = targets.breathe ? breathAt(now / 1000) : 0;

  return {
    y: rig.drop.x - targets.lift - breath,
    rotate: rig.lean.x + targets.shake,
    squash: targets.squash,
    stretch: (breath / BREATH.amp) * BREATH.stretch,
    shade: 0,
    gazeX: rig.gazeX.x,
    gazeY: rig.gazeY.x,
    eyeScale: rig.eyeScale,
    lid,
    lidWidth: 1,
    lens: 1,
    arch: rig.arch,
    smile: rig.smile,
    brow: rig.brow,
    led: rig.led,
    scan: targets.scan ? ((now / 1000) * SCAN_HZ) % 1 : -1,
    airborne: Math.max(0, targets.lift + breath),
    puff: -1,
  };
};

const initialEntrance = (entrance: MascotEntrance | undefined, now: number): EntranceState => {
  if (entrance === 'play') {
    return { phase: 'playing', at: now };
  }
  return entrance === 'wait' ? { phase: 'waiting' } : { phase: 'none' };
};

const entranceAt = (state: EntranceState, now: number): EntrancePose | null => {
  if (state.phase === 'waiting') {
    return ENTRANCE_WAITING;
  }
  return state.phase === 'playing' ? entrancePose(now - state.at) : null;
};

const freshRig = (now: number): RigState => ({
  gazeX: { x: 0, v: 0 },
  gazeY: { x: 4, v: 0 },
  lean: { x: 0, v: 0 },
  drop: { x: 0, v: 0 },
  eyeScale: 1,
  arch: 1,
  smile: 0,
  brow: 0,
  led: 1,
  lid: 1,
  blinkFrom: -Infinity,
  blinkAt: now + TIMING.wakeMs + TIMING.blinkMinMs,
  lastKeySeen: 0,
  glance: { x: 0, y: 4 },
  glanceAt: now + TIMING.glanceMinMs,
  beat: '',
  beatAt: now,
});

function Mascot({
  source,
  variant = 'teal',
  entrance,
  className,
  title,
}: MascotProps): React.ReactElement {
  const rootRef = useRef<SVGSVGElement>(null);
  const sourceRef = useRef(source);
  const entranceRef = useRef(entrance);
  const paintRef = useRef(PAINT[variant]);

  sourceRef.current = source;
  entranceRef.current = entrance;
  paintRef.current = PAINT[variant];

  /* A layout effect, so a mark that enters from above is never painted in place first. */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const parts = queryParts(root);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(pointer: fine)');
    const started = performance.now();
    const rig = freshRig(started);

    let state = initialEntrance(reduced ? undefined : entranceRef.current, started);
    /* With an entrance the eyes boot open, so there is no waking beat after it. */
    const mountedAt = state.phase === 'none' ? started : -Infinity;

    const measureDrop = (): number => {
      const box = root.getBoundingClientRect();
      return (dropHeightPx(box.bottom) * VIEW_WIDTH) / Math.max(1, box.width);
    };
    let dropUnits = measureDrop();
    let frame = 0;
    let last = started;
    let pointer: PointerSample | null = null;

    /* A coordinate and a timestamp, nothing stored and nothing sent. */
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
    };

    const step = (now: number) => {
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      const input = sourceRef.current.read();

      if (state.phase === 'waiting' && entranceRef.current === 'play') {
        state = { phase: 'playing', at: now };
        dropUnits = measureDrop();
      }
      /* Password focus outranks the entrance, as it outranks everything below success. */
      if (state.phase !== 'none' && input.secretFocused) {
        state = { phase: 'none' };
      }

      const entering = entranceAt(state, now);
      if (state.phase === 'playing' && entering === null) {
        state = { phase: 'none' };
        rig.blinkAt = now + TIMING.blinkMinMs;
      }

      const signals: MascotSignals = {
        ...input,
        pointer: fine.matches ? pointer : null,
        mountedAt,
      };
      let next: Frame;
      if (entering) {
        next = entranceFrame(entering, rig, dt, dropUnits);
      } else if (reduced) {
        next = stillFrame(resolveBeat(signals, now), rig, dt);
      } else {
        next = ladderFrame(signals, rig, now, dt, root.getBoundingClientRect());
      }
      paint(parts, next, paintRef.current.groundOpacity);
    };

    const loop = (now: number) => {
      step(now);
      frame = requestAnimationFrame(loop);
    };

    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (document.hidden) {
        return;
      }
      last = performance.now();
      frame = requestAnimationFrame(loop);
    };

    step(started);
    frame = requestAnimationFrame(loop);
    document.addEventListener('visibilitychange', onVisibility);
    if (!reduced) {
      document.addEventListener('pointermove', onPointerMove, { passive: true });
    }

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  const paintSet = PAINT[variant];
  const groundId = `synapse-mascot-ground-${variant}`;

  return (
    <svg
      ref={rootRef}
      viewBox={VIEW_BOX}
      className={className}
      style={{ overflow: 'visible' }}
      role="img"
      aria-label={title}
      aria-hidden={title === undefined ? true : undefined}
    >
      <defs>
        <linearGradient
          id="synapse-mascot-shell"
          x1="0"
          y1="340.59"
          x2="681.39"
          y2="340.59"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#328a8a" />
          <stop offset="0.61" stopColor="#186569" />
          <stop offset="1" stopColor="#134f54" />
        </linearGradient>
        <linearGradient id="synapse-mascot-lens" x1="0.1" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#1e7276" />
          <stop offset="1" stopColor="#0e3c41" />
        </linearGradient>
        <radialGradient id={groundId}>
          <stop offset="0" stopColor={paintSet.ground} stopOpacity="1" />
          <stop offset="1" stopColor={paintSet.ground} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="synapse-mascot-scan" x1="0" y1="1" x2="0" y2="0">
          <stop data-part="scan-stop" offset="0" stopColor={paintSet.scan} stopOpacity="0" />
          <stop data-part="scan-stop" offset="0.5" stopColor={paintSet.scan} stopOpacity="0.85" />
          <stop data-part="scan-stop" offset="1" stopColor={paintSet.scan} stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse
        data-part="ground"
        cx="340"
        cy="694"
        rx="250"
        ry="18"
        fill={`url(#${groundId})`}
        opacity={paintSet.groundOpacity}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
      />
      <g aria-hidden="true">
        {Array.from({ length: PUFF_COUNT }, (_, i) => (
          <circle
            key={i}
            data-part="puff"
            cx="340"
            cy="688"
            r="24"
            fill={paintSet.puff}
            opacity="0"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          />
        ))}
      </g>
      <g data-part="rig" style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}>
        <path d={BODY} fill={paintSet.shell} />
        <rect
          x="177.54"
          y="105.74"
          width="426.15"
          height="464"
          rx="145.07"
          transform="translate(47.6 -48.25) rotate(7.53)"
          fill={paintSet.face}
        />
        <rect
          x="48.25"
          y="146.92"
          width="102.54"
          height="215.8"
          rx="51.27"
          transform="translate(40.18 -12.23) rotate(8.81)"
          fill={paintSet.face}
        />
        <path data-part="shade" d={BODY} fill={paintSet.shade} opacity="0" />
        <rect
          data-part="pill"
          x="62.7"
          y="171.07"
          width="73.67"
          height="167.36"
          rx="36.83"
          transform="translate(40.17 -12.24) rotate(8.81)"
          fill={paintSet.pill}
        />
        <rect
          data-part="scan"
          x="62.7"
          y="171.07"
          width="73.67"
          height="167.36"
          rx="36.83"
          transform="translate(40.17 -12.24) rotate(8.81)"
          fill="url(#synapse-mascot-scan)"
          opacity="0"
        />
        <g data-part="gaze" style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}>
          <g
            data-part="lid-left"
            opacity="0"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          >
            <ellipse cx="374.8" cy="292" rx="36" ry="38" fill={paintSet.lens} />
            <g data-part="glint">
              <ellipse
                cx="361"
                cy="276"
                rx="10.5"
                ry="8"
                fill={paintSet.glint}
                opacity={paintSet.glintOpacity}
                transform="rotate(-20 361 276)"
              />
            </g>
          </g>
          <g
            data-part="lid-right"
            opacity="0"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          >
            <ellipse cx="538" cy="316" rx="28" ry="30" fill={paintSet.lens} />
            <g data-part="glint">
              <ellipse
                cx="527.5"
                cy="303"
                rx="8"
                ry="6.2"
                fill={paintSet.glint}
                opacity={paintSet.glintOpacity}
                transform="rotate(-20 527.5 303)"
              />
            </g>
          </g>
          <g data-part="arch" opacity="1">
            <path d={ARCH_LEFT} fill={paintSet.arch} />
            <path d={ARCH_RIGHT} fill={paintSet.arch} />
          </g>
          <g data-part="brow" opacity="0">
            <rect
              x="343.8"
              y="225.5"
              width="62"
              height="13"
              rx="6.5"
              fill={paintSet.arch}
              transform="rotate(-17 374.8 232)"
            />
            <rect
              x="514"
              y="252.5"
              width="48"
              height="11"
              rx="5.5"
              fill={paintSet.arch}
              transform="rotate(17 538 258)"
            />
          </g>
        </g>
        <g
          data-part="mouth"
          opacity="0"
          style={{ transformBox: 'fill-box', transformOrigin: '50% 0%' }}
        >
          <path
            d={SMILE}
            fill="none"
            stroke={paintSet.arch}
            strokeWidth="12"
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  );
}

export default Mascot;
