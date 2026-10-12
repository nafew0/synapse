import { renderHook } from '@testing-library/react';
import useToastArea from '../useToastArea';

function layout({
  left,
  width,
  containerWidth,
}: Record<'left' | 'width' | 'containerWidth', number>) {
  const container = document.createElement('div');
  const pane = document.createElement('div');
  container.appendChild(pane);
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { value: containerWidth });
  Object.defineProperty(pane, 'offsetLeft', { value: left });
  Object.defineProperty(pane, 'offsetWidth', { value: width });
  return { pane, container };
}

const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('useToastArea', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('publishes the pane insets so toasts centre over the chat column', () => {
    const { pane } = layout({ left: 260, width: 1000, containerWidth: 1400 });
    const { unmount } = renderHook(() =>
      useToastArea({ paneRef: { current: pane }, enabled: true }),
    );

    expect(readVar('--toast-area-left')).toBe('260px');
    expect(readVar('--toast-area-right')).toBe('140px');

    unmount();
    expect(readVar('--toast-area-left')).toBe('');
    expect(readVar('--toast-area-right')).toBe('');
  });

  it('leaves the toast centred on the window when disabled', () => {
    const { pane } = layout({ left: 260, width: 1000, containerWidth: 1260 });
    renderHook(() => useToastArea({ paneRef: { current: pane }, enabled: false }));

    expect(readVar('--toast-area-left')).toBe('');
    expect(readVar('--toast-area-right')).toBe('');
  });
});
