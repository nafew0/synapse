import { useRef } from 'react';
import { render } from '@testing-library/react';
import useVoiceLevel, { readVoiceBands, VOICE_BAR_COUNT } from '../useVoiceLevel';

const loudAnalyser = (value: number) =>
  ({
    frequencyBinCount: 128,
    getByteFrequencyData: (data: Uint8Array) => data.fill(value),
  }) as unknown as AnalyserNode;

function Harness({ active, analyser }: { active: boolean; analyser: AnalyserNode | null }) {
  const analyserRef = useRef<AnalyserNode | null>(analyser);
  const barsRef = useRef<HTMLSpanElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useVoiceLevel({ active, analyserRef, barsRef, composerRef });
  return (
    <div ref={composerRef} data-testid="composer">
      <span ref={barsRef} data-testid="bars">
        {Array.from({ length: VOICE_BAR_COUNT }, (_, i) => (
          <span key={i} />
        ))}
      </span>
    </div>
  );
}

describe('readVoiceBands', () => {
  it('returns zero for silence and caps loud input at one', () => {
    expect(readVoiceBands(new Uint8Array(128), 5)).toEqual([0, 0, 0, 0, 0]);
    expect(readVoiceBands(new Uint8Array(128).fill(255), 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it('reads only the speech range, so high frequencies do not move the bars', () => {
    const data = new Uint8Array(128);
    data.fill(255, 40);
    expect(readVoiceBands(data, 5)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('useVoiceLevel', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('marks the composer and scales the bars with the voice while recording', () => {
    const { getByTestId, rerender } = render(
      <Harness active={true} analyser={loudAnalyser(255)} />,
    );
    frames.shift()?.(0);

    const composer = getByTestId('composer');
    expect(composer.hasAttribute('data-recording')).toBe(true);
    expect(getByTestId('bars').hasAttribute('data-live')).toBe(true);
    expect(Number(composer.style.getPropertyValue('--lc-voice-level'))).toBeGreaterThan(0);
    expect(getByTestId('bars').querySelector('span')?.style.transform).toMatch(/^scaleY\(0\.[3-9]/);

    rerender(<Harness active={false} analyser={loudAnalyser(255)} />);
    expect(composer.hasAttribute('data-recording')).toBe(false);
    expect(composer.style.getPropertyValue('--lc-voice-level')).toBe('');
  });

  it('only marks the composer when there is no analyser to measure', () => {
    const { getByTestId } = render(<Harness active={true} analyser={null} />);
    expect(getByTestId('composer').hasAttribute('data-recording')).toBe(true);
    expect(getByTestId('bars').hasAttribute('data-live')).toBe(false);
    expect(frames).toHaveLength(0);
  });
});
