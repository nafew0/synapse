import { useEffect } from 'react';
import type { RefObject } from 'react';

export const VOICE_BAR_COUNT = 5;

/** Loudest band in the middle bar, quieter bands toward the edges */
const BAR_BANDS = [3, 1, 0, 2, 4];
const SPEECH_BINS = 30;
const MIN_BAR_SCALE = 0.25;
const SMOOTHING = 0.5;
const LEVEL_GAIN = 1.3;

/** Splits the speech range of a frequency snapshot into `bandCount` loudness values from 0 to 1. */
export const readVoiceBands = (data: Uint8Array, bandCount: number): number[] => {
  const speechBins = Math.min(data.length - 1, SPEECH_BINS);
  const perBand = Math.max(1, Math.floor(speechBins / bandCount));
  return Array.from({ length: bandCount }, (_, band) => {
    const start = 1 + band * perBand;
    const end = Math.min(start + perBand, data.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += data[i];
    }
    return Math.min(1, sum / perBand / 200);
  });
};

interface VoiceLevelOptions {
  active: boolean;
  analyserRef?: RefObject<AnalyserNode | null>;
  barsRef: RefObject<HTMLElement>;
  composerRef?: RefObject<HTMLElement>;
}

/**
 * While recording, marks the composer with `data-recording` and drives the mic bars and the
 * composer's `--lc-voice-level` from the live analyser, writing to the DOM each frame so the
 * chat form does not re-render. Without an analyser or with reduced motion, CSS shows a static state.
 */
export default function useVoiceLevel({
  active,
  analyserRef,
  barsRef,
  composerRef,
}: VoiceLevelOptions) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const composer = composerRef?.current;
    composer?.setAttribute('data-recording', '');

    const analyser = analyserRef?.current;
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bars = barsRef.current?.querySelectorAll<HTMLElement>('span') ?? [];
    if (!analyser || reduceMotion || bars.length === 0) {
      return () => composer?.removeAttribute('data-recording');
    }

    barsRef.current?.setAttribute('data-live', '');
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bands = new Array<number>(VOICE_BAR_COUNT).fill(0);
    let level = 0;
    let frame = 0;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const next = readVoiceBands(data, VOICE_BAR_COUNT);
      let total = 0;
      for (let i = 0; i < VOICE_BAR_COUNT; i++) {
        bands[i] = bands[i] * SMOOTHING + next[i] * (1 - SMOOTHING);
        total += bands[i];
      }
      level =
        level * SMOOTHING + Math.min(1, (total / VOICE_BAR_COUNT) * LEVEL_GAIN) * (1 - SMOOTHING);
      composer?.style.setProperty('--lc-voice-level', level.toFixed(3));
      bars.forEach((bar, i) => {
        const scale = MIN_BAR_SCALE + bands[BAR_BANDS[i] ?? 0] * (1 - MIN_BAR_SCALE);
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      composer?.removeAttribute('data-recording');
      composer?.style.removeProperty('--lc-voice-level');
    };
  }, [active, analyserRef, barsRef, composerRef]);
}
