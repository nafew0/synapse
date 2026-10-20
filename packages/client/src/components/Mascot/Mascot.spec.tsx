import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import type { MascotInput, MascotInputSource } from './pose';
import Mascot from './Mascot';

const input = (overrides: Partial<MascotInput> = {}): MascotInput => ({
  secretFocused: false,
  submitting: false,
  succeeded: false,
  failedAt: 0,
  lastKeyAt: 0,
  ...overrides,
});

const sourceOf = (value: MascotInput): MascotInputSource => ({ read: () => value });

/** The setup file stubs matchMedia as always-false; this lets a test opt in. */
const setMedia = (matches: (query: string) => boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  });
};

describe('Mascot', () => {
  it('renders the mark and labels it when given a title', () => {
    const { getByRole } = render(<Mascot source={sourceOf(input())} title="Synapse logo" />);
    expect(getByRole('img', { name: 'Synapse logo' })).toBeInTheDocument();
  });

  it('hides itself from assistive tech when it carries no title', () => {
    const { container } = render(<Mascot source={sourceOf(input())} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('paints the white lockup with an inverted eye contrast', () => {
    const { container } = render(<Mascot source={sourceOf(input())} variant="white" />);
    const [shell] = Array.from(container.querySelectorAll('path'));
    const lens = container.querySelector('[data-part="lid-left"] ellipse');
    expect(shell).toHaveAttribute('fill', '#FFFFFF');
    expect(lens).toHaveAttribute('fill', '#FFFFFF');
  });

  it('opens on the resting arch with the lenses hidden, so the first frame is the shipped mark', () => {
    const { container } = render(<Mascot source={sourceOf(input())} />);
    const part = (name: string) => container.querySelector(`[data-part="${name}"]`) as SVGElement;
    expect(Number(part('arch').style.opacity)).toBe(1);
    expect(Number(part('lid-left').style.opacity)).toBe(0);
    expect(Number(part('brow').style.opacity)).toBe(0);
    expect(Number(part('mouth').style.opacity)).toBe(0);
  });

  it('holds still under reduced motion, but still smiles for the password', () => {
    setMedia((query) => query.includes('prefers-reduced-motion'));
    const frames: FrameRequestCallback[] = [];
    const raf = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => frames.push(callback));
    const { container } = render(
      <Mascot source={sourceOf(input({ secretFocused: true }))} entrance="play" />,
    );
    const start = performance.now();
    for (let i = 1; i <= 120; i++) {
      frames.shift()?.(start + i * 16);
    }
    const part = (name: string) => container.querySelector(`[data-part="${name}"]`) as SVGElement;
    expect(part('rig').style.transform).toContain('translate(0px,0.00px) rotate(0.00deg)');
    expect(Number(part('mouth').style.opacity)).toBeGreaterThan(0.9);
    expect(Number(part('lid-left').style.opacity)).toBeGreaterThan(0.9);
    raf.mockRestore();
    setMedia(() => false);
  });

  it('starts an entrance above its resting place, switched off', () => {
    const { container } = render(<Mascot source={sourceOf(input())} entrance="wait" />);
    const part = (name: string) => container.querySelector(`[data-part="${name}"]`) as SVGElement;
    expect(part('rig').style.transform).toMatch(/translate\(0px,-\d/);
    expect(Number(part('shade').style.opacity)).toBeGreaterThan(0.8);
    expect(Number(part('pill').style.opacity)).toBe(0);
  });

  it('skips the entrance when the password field already has focus', () => {
    const { container } = render(
      <Mascot source={sourceOf(input({ secretFocused: true }))} entrance="play" />,
    );
    const rig = container.querySelector('[data-part="rig"]') as SVGElement;
    expect(rig.style.transform).toMatch(/translate\(0px,-?\d{1,2}\.\d+px\)/);
  });

  it('stops its loop and drops its listeners on unmount', () => {
    const cancel = jest.spyOn(window, 'cancelAnimationFrame');
    const remove = jest.spyOn(document, 'removeEventListener');
    const { unmount } = render(<Mascot source={sourceOf(input())} />);

    unmount();

    expect(cancel).toHaveBeenCalled();
    const removed = remove.mock.calls.map(([event]) => event);
    expect(removed).toContain('pointermove');
    expect(removed).toContain('visibilitychange');
    cancel.mockRestore();
    remove.mockRestore();
  });

  it('reads the source rather than capturing it, so later signals are seen', () => {
    const read = jest.fn(() => input());
    render(<Mascot source={{ read }} />);
    expect(typeof read).toBe('function');
  });
});
