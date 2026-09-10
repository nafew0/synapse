import { useEffect, useMemo, useRef } from 'react';
import { useRecoilState } from 'recoil';
import type { TBanner } from 'librechat-data-provider';
import {
  CONFIG_HTML_TEXT_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import {
  useGetBannerQuery,
  useDismissBannerMutation,
  useMarkBannerSeenMutation,
} from '~/data-provider';
import { useAuthContext } from '~/hooks';
import store from '~/store';
import Card from './Card';
import Bar from './Bar';

/**
 * Signed-in users: the server filters out banners they have seen (`once`) or
 * dismissed, so this only reports those events back. Anonymous visitors (login
 * page) fall back to `localStorage`, which also keeps dismissals made before
 * server-side tracking existed.
 */
function useBannerVisibility(banner: TBanner | null | undefined, userId?: string) {
  const [hiddenIds, setHiddenIds] = useRecoilState<string[]>(store.hideBannerHint);
  const shownThisVisit = useRef(new Set<string>());
  const { mutate: markSeen } = useMarkBannerSeenMutation();
  const { mutate: recordDismiss } = useDismissBannerMutation(userId);

  const bannerId = banner?.bannerId;
  const display = banner?.display;
  const isVisible =
    bannerId != null &&
    (display === 'always' || shownThisVisit.current.has(bannerId) || !hiddenIds.includes(bannerId));

  useEffect(() => {
    if (!isVisible || !bannerId || shownThisVisit.current.has(bannerId)) {
      return;
    }
    shownThisVisit.current.add(bannerId);
    if (display !== 'once') {
      return;
    }
    if (userId) {
      markSeen(bannerId);
      return;
    }
    setHiddenIds((ids) => (ids.includes(bannerId) ? ids : [...ids, bannerId]));
  }, [isVisible, bannerId, display, userId, markSeen, setHiddenIds]);

  const dismiss = () => {
    if (!bannerId) {
      return;
    }
    shownThisVisit.current.delete(bannerId);
    setHiddenIds((ids) => (ids.includes(bannerId) ? ids : [...ids, bannerId]));
    if (userId) {
      recordDismiss(bannerId);
    }
  };

  return { isVisible, dismiss };
}

export const Banner = ({ onHeightChange }: { onHeightChange?: (height: number) => void }) => {
  const { user, isAuthenticated } = useAuthContext();
  const userId = isAuthenticated ? user?.id : undefined;
  const { data: banner } = useGetBannerQuery(userId);
  const { isVisible, dismiss } = useBannerVisibility(banner, userId);
  const barRef = useRef<HTMLDivElement>(null);
  const isBar = isVisible && banner?.type !== 'popup';
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_TEXT_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  const sanitizedMessage = useMemo(
    () => (banner?.message ? sanitize(banner.message) : ''),
    [banner?.message, sanitize],
  );

  useEffect(() => {
    const element = barRef.current;
    if (!onHeightChange) {
      return;
    }
    if (!element || !isBar) {
      onHeightChange(0);
      return;
    }
    const observer = new ResizeObserver(() => onHeightChange(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [isBar, onHeightChange]);

  if (!banner || !isVisible) {
    return null;
  }

  if (banner.type === 'popup') {
    return <Card banner={banner} message={sanitizedMessage} onDismiss={dismiss} />;
  }
  return <Bar ref={barRef} banner={banner} message={sanitizedMessage} onDismiss={dismiss} />;
};
