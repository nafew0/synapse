import React, { useRef, useEffect } from 'react';
import type { MascotInputSource, PointerSample, MascotTargets, GazeAim } from './pose';
import { aimFromPointer, nextBlinkDelay, resolveBeat, targetsFor, TIMING } from './pose';

/**
 * The shell, face plate and status pill are the unmodified geometry of
 * `icon_synapse_v1.svg`. The eyes and brows are the only additions: the mark
 * ships with the resting arch, which the rig treats as its closed pose.
 */
const BODY =
  'M.33,419.41,32.54,181.28S52.2,4.1,250.27,0C451.11,25.69,497.16,32.07,497.16,32.07s80.71,2.36,145.45,92.21c51,67.26,37,152.45,37,152.45q-1.41,10.36-2.83,20.73-2.53,10.23-5,20.46a115.78,115.78,0,0,1-6,15.5c-2.7,5.74-3.72,6.64-7.4,14.44s-4.84,11.53-5.53,15a35.07,35.07,0,0,0-.86,8.77c.2,5,1.56,9,2.88,12.88,1.1,3.24,1.46,3.5,3,7.89a52.25,52.25,0,0,1,2.25,7.57c.55,3.37.34,6.21-.07,11.87-.11,1.46-.23,2.67-.33,4.89-.15,3.11-.07,4.14-.53,8.23-.37,3.22-.94,8-1.71,13.84-4.32,32.22-6.95,82.43-26.26,116.88C616.47,581.93,567,689.25,414,680.69,288.2,668.21,167.54,646,167.54,646S-8.68,607.06.33,419.41Z';
const ARCH_LEFT =
  'M410.78,310.42l0,.12a6.62,6.62,0,0,1-10.23,4.58A63.36,63.36,0,0,0,347,307.78a6.62,6.62,0,0,1-8.63-7.17l0-.11c3.29-24,22.16-41.25,42.15-38.51S414.07,286.42,410.78,310.42Z';
const ARCH_RIGHT =
  'M510.26,326.64l0,.1c-.6,4.42,2.89,7.79,6.46,6.33a41.31,41.31,0,0,1,40.81,5.6c3,2.36,7.31.05,7.92-4.36l0-.11c3-21.85-6.93-41.25-22.17-43.34S513.25,304.78,510.26,326.64Z';

/** 140 units of side room for the lean, 80 of headroom for the bob and hop. */
const VIEW_BOX = '-140 -80 961.39 791.17';

type LockupVariant = 'teal' | 'white';

interface LockupPaint {
  shell: string;
  face: string;
  lens: string;
  glint: string;
  glintOpacity: number;
  arch: string;
  pill: string;
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
  },
  white: {
    shell: '#FFFFFF',
    face: '#D2D2D1',
    lens: '#FFFFFF',
    glint: '#BFBFBE',
    glintOpacity: 0.75,
    arch: '#FFFFFF',
    pill: '#F47948',
  },
};

export interface MascotProps {
  /** Read once per frame; keystrokes must not re-render the tree. */
  source: MascotInputSource;
  variant?: LockupVariant;
  className?: string;
  title?: string;
}

interface RigState {
  gazeX: number;
  gazeY: number;
  lean: number;
  drop: number;
  eyeScale: number;
  archOpacity: number;
  browOpacity: number;
  lid: number;
  lidRight: number;
  blinkAt: number;
  blinkPhase: number;
  blinkFrom: number;
  queued: boolean;
  beatAt: number;
  beat: string;
}

const approach = (value: number, target: number, rate: number): number =>
  value + (target - value) * Math.min(1, rate);

/**
 * Advances the blink state machine and returns the lid opening. Kept out of
 * `pose.ts` because it carries its own clock rather than describing a pose.
 */
const stepBlink = (rig: RigState, now: number, delta: number, busy: boolean): number => {
  if (rig.blinkPhase === 0) {
    if (now < rig.blinkAt) {
      return approach(rig.lid, 1, delta * 12);
    }
    rig.blinkPhase = 1;
    rig.blinkFrom = now;
    rig.queued = Math.random() < TIMING.doubleBlinkChance;
  }
  if (rig.blinkPhase === 1) {
    const progress = (now - rig.blinkFrom) / TIMING.lidCloseMs;
    if (progress >= 1) {
      rig.blinkPhase = 2;
      rig.blinkFrom = now;
    }
    return 1 - Math.min(1, progress) * 0.94;
  }
  if (rig.blinkPhase === 2) {
    if (now - rig.blinkFrom > TIMING.lidHoldMs) {
      rig.blinkPhase = 3;
      rig.blinkFrom = now;
    }
    return 0.06;
  }
  const progress = (now - rig.blinkFrom) / TIMING.lidOpenMs;
  if (progress >= 1) {
    rig.blinkPhase = 0;
    if (rig.queued) {
      rig.queued = false;
      rig.blinkAt = now + 70;
    } else {
      rig.blinkAt = now + nextBlinkDelay(busy, Math.random());
    }
  }
  return 0.06 + Math.min(1, progress) * 0.94;
};

function Mascot({ source, variant = 'teal', className, title }: MascotProps): React.ReactElement {
  const rootRef = useRef<SVGSVGElement>(null);
  const rigRef = useRef<SVGGElement>(null);
  const gazeRef = useRef<SVGGElement>(null);
  const lidLeftRef = useRef<SVGGElement>(null);
  const lidRightRef = useRef<SVGGElement>(null);
  const archRef = useRef<SVGGElement>(null);
  const browRef = useRef<SVGGElement>(null);
  const pillRef = useRef<SVGRectElement>(null);
  const sourceRef = useRef(source);

  sourceRef.current = source;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(pointer: fine)');
    if (reduced.matches) {
      return;
    }

    const rig: RigState = {
      gazeX: 0,
      gazeY: 4,
      lean: 0,
      drop: 0,
      eyeScale: 1,
      archOpacity: 1,
      browOpacity: 0,
      lid: 1,
      lidRight: 1,
      blinkAt: performance.now() + TIMING.wakeMs,
      blinkPhase: 0,
      blinkFrom: 0,
      queued: false,
      beatAt: performance.now(),
      beat: '',
    };

    let frame = 0;
    let last = performance.now();
    const started = last;
    let pointer: PointerSample | null = null;

    /* A coordinate and a timestamp, nothing stored and nothing sent. */
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== 'mouse') {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
    };

    const tick = (now: number) => {
      const delta = Math.min(0.064, (now - last) / 1000);
      last = now;
      const seconds = (now - started) / 1000;
      const current = {
        ...sourceRef.current.read(),
        pointer: fine.matches ? pointer : null,
        mountedAt: started,
      };

      const beat = resolveBeat(current, now);
      if (beat !== rig.beat) {
        rig.beat = beat;
        rig.beatAt = now;
      }

      let aim: GazeAim | null = null;
      if (beat === 'tracking' && current.pointer && rootRef.current) {
        aim = aimFromPointer(current.pointer, rootRef.current.getBoundingClientRect());
      }

      const targets: MascotTargets = targetsFor(beat, now - rig.beatAt, seconds, aim);

      rig.gazeX = approach(rig.gazeX, targets.gazeX, delta * 6);
      rig.gazeY = approach(rig.gazeY, targets.gazeY, delta * 6);
      rig.lean = approach(rig.lean, targets.lean, delta * 4.5);
      rig.drop = approach(rig.drop, targets.drop, delta * 4.5);
      rig.eyeScale = approach(rig.eyeScale, targets.eyeScale, delta * 4.5);
      rig.archOpacity = approach(rig.archOpacity, targets.arch ? 1 : 0, delta * 9);
      rig.browOpacity = approach(rig.browOpacity, targets.brow ? 1 : 0, delta * 7);

      if (targets.arch) {
        rig.lid = 1;
        rig.blinkPhase = 0;
      } else if (targets.lidHold >= 0) {
        rig.lid = approach(rig.lid, targets.lidHold, delta * 9);
        rig.blinkPhase = 0;
      } else {
        rig.lid = stepBlink(rig, now, delta, beat === 'busy');
      }
      rig.lidRight =
        targets.lidHoldRight >= 0
          ? approach(rig.lidRight, targets.lidHoldRight, delta * 9)
          : rig.lid;

      const wave = Math.sin(seconds * Math.PI * 2 * targets.bobHz);
      const lift = (wave * 0.5 + 0.5) * targets.bobAmp;
      const squash = wave * 0.018;
      const origin = targets.lidFromTop ? '50% 100%' : '50% 50%';

      if (rigRef.current) {
        rigRef.current.style.transform =
          `translate(${targets.shake.toFixed(2)}px,${(rig.drop - lift).toFixed(2)}px) ` +
          `rotate(${rig.lean.toFixed(2)}deg) ` +
          `scale(${(1 - squash).toFixed(4)},${(1 + squash).toFixed(4)})`;
      }
      if (gazeRef.current) {
        gazeRef.current.style.transform =
          `translate(${rig.gazeX.toFixed(2)}px,${rig.gazeY.toFixed(2)}px) ` +
          `scale(${rig.eyeScale.toFixed(3)})`;
      }
      const lensOpacity = (1 - rig.archOpacity).toFixed(3);
      if (lidLeftRef.current) {
        lidLeftRef.current.style.transformOrigin = origin;
        lidLeftRef.current.style.transform = `scaleY(${rig.lid.toFixed(3)})`;
        lidLeftRef.current.style.opacity = lensOpacity;
      }
      if (lidRightRef.current) {
        lidRightRef.current.style.transformOrigin = origin;
        lidRightRef.current.style.transform = `scaleY(${rig.lidRight.toFixed(3)})`;
        lidRightRef.current.style.opacity = lensOpacity;
      }
      if (archRef.current) {
        archRef.current.style.opacity = rig.archOpacity.toFixed(3);
      }
      if (browRef.current) {
        browRef.current.style.opacity = rig.browOpacity.toFixed(3);
        browRef.current.style.transform = `translateY(${((1 - rig.browOpacity) * -16).toFixed(1)}px)`;
      }
      if (pillRef.current) {
        const pulse =
          targets.ledHz === 0
            ? targets.ledFloor
            : targets.ledFloor +
              (1 - targets.ledFloor) *
                (0.5 + 0.5 * Math.sin(seconds * Math.PI * 2 * targets.ledHz));
        pillRef.current.style.opacity = pulse.toFixed(3);
      }

      frame = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        return;
      }
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  const paint = PAINT[variant];

  return (
    <svg
      ref={rootRef}
      viewBox={VIEW_BOX}
      className={className}
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
      </defs>
      <g
        ref={rigRef}
        data-part="rig"
        style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
      >
        <path d={BODY} fill={paint.shell} />
        <rect
          x="177.54"
          y="105.74"
          width="426.15"
          height="464"
          rx="145.07"
          transform="translate(47.6 -48.25) rotate(7.53)"
          fill={paint.face}
        />
        <rect
          x="48.25"
          y="146.92"
          width="102.54"
          height="215.8"
          rx="51.27"
          transform="translate(40.18 -12.23) rotate(8.81)"
          fill={paint.face}
        />
        <rect
          ref={pillRef}
          x="62.7"
          y="171.07"
          width="73.67"
          height="167.36"
          rx="36.83"
          transform="translate(40.17 -12.24) rotate(8.81)"
          fill={paint.pill}
        />
        <g
          ref={gazeRef}
          data-part="gaze"
          style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
        >
          <g
            ref={lidLeftRef}
            data-part="lid-left"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          >
            <ellipse cx="374.8" cy="292" rx="36" ry="38" fill={paint.lens} />
            <ellipse
              cx="361"
              cy="276"
              rx="10.5"
              ry="8"
              fill={paint.glint}
              opacity={paint.glintOpacity}
              transform="rotate(-20 361 276)"
            />
          </g>
          <g
            ref={lidRightRef}
            data-part="lid-right"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          >
            <ellipse cx="538" cy="316" rx="28" ry="30" fill={paint.lens} />
            <ellipse
              cx="527.5"
              cy="303"
              rx="8"
              ry="6.2"
              fill={paint.glint}
              opacity={paint.glintOpacity}
              transform="rotate(-20 527.5 303)"
            />
          </g>
          <g ref={archRef} data-part="arch" opacity="1">
            <path d={ARCH_LEFT} fill={paint.arch} />
            <path d={ARCH_RIGHT} fill={paint.arch} />
          </g>
          <g ref={browRef} data-part="brow" opacity="0">
            <rect
              x="343.8"
              y="225.5"
              width="62"
              height="13"
              rx="6.5"
              fill={paint.arch}
              transform="rotate(-17 374.8 232)"
            />
            <rect
              x="514"
              y="252.5"
              width="48"
              height="11"
              rx="5.5"
              fill={paint.arch}
              transform="rotate(17 538 258)"
            />
          </g>
        </g>
      </g>
    </svg>
  );
}

export default Mascot;
