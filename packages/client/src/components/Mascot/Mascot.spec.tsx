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
    const lens = container.querySelector('ellipse');
    expect(shell).toHaveAttribute('fill', '#FFFFFF');
    expect(lens).toHaveAttribute('fill', '#FFFFFF');
  });

  it('opens on the resting arch, with brows down, so the first frame is the shipped mark', () => {
    const { container } = render(<Mascot source={sourceOf(input())} />);
    expect(container.querySelector('[data-part="arch"]')).toHaveAttribute('opacity', '1');
    expect(container.querySelector('[data-part="brow"]')).toHaveAttribute('opacity', '0');
  });

  it('runs no animation frames when the viewer asks for reduced motion', () => {
    setMedia((query) => query.includes('prefers-reduced-motion'));
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    render(<Mascot source={sourceOf(input())} />);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
    setMedia(() => false);
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
