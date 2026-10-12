import { useEffect } from 'react';
import type { RefObject } from 'react';

const LEFT_VAR = '--toast-area-left';
const RIGHT_VAR = '--toast-area-right';

function clearArea(style: CSSStyleDeclaration) {
  style.removeProperty(LEFT_VAR);
  style.removeProperty(RIGHT_VAR);
}

/**
 * Publishes the chat pane's horizontal insets as CSS variables so the app-wide
 * toast viewport centres over the chat column instead of the whole window.
 * Uses offset metrics, which ignore the pane's slide-in transform.
 */
export default function useToastArea({
  paneRef,
  enabled,
}: {
  paneRef: RefObject<HTMLElement>;
  enabled: boolean;
}) {
  useEffect(() => {
    const { style } = document.documentElement;
    const pane = paneRef.current;
    const container = pane?.parentElement;
    if (!enabled || !pane || !container || typeof ResizeObserver === 'undefined') {
      clearArea(style);
      return;
    }

    const update = () => {
      const left = pane.offsetLeft;
      const right = container.clientWidth - left - pane.offsetWidth;
      style.setProperty(LEFT_VAR, `${Math.max(left, 0)}px`);
      style.setProperty(RIGHT_VAR, `${Math.max(right, 0)}px`);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    observer.observe(container);
    return () => {
      observer.disconnect();
      clearArea(style);
    };
  }, [paneRef, enabled]);
}
