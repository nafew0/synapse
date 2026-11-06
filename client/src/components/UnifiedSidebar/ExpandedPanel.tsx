import { memo, useCallback, lazy, Suspense } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { PanelLeft, SquarePen } from 'lucide-react';
import { Skeleton, Button, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { Logo } from '~/components/Brand';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import store from '~/store';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

const railItemClass =
  'lc-rail-item relative flex size-10 items-center justify-center rounded-[10px] transition-colors';

const NewChatButton = memo(function NewChatButton({
  setActive,
}: {
  setActive: (id: string) => void;
}) {
  const localize = useLocalize();
  const switchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handlePanelSwitch = useCallback(() => {
    if (switchToHistory) {
      setActive(DEFAULT_PANEL);
    }
  }, [switchToHistory, setActive]);

  const { handleNewChatClick } = useNewChat({ onNewChat: handlePanelSwitch });

  return (
    <TooltipAnchor
      side="right"
      description={tooltipDescription}
      render={
        <a
          href="/c/new"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          aria-keyshortcuts={ariaKey}
          className="lc-rail-new mb-1.5 flex size-9 items-center justify-center rounded-[10px] transition-colors"
          onClick={handleNewChatClick}
        >
          <SquarePen className="size-[18px]" aria-hidden="true" />
        </a>
      }
    />
  );
});

const NavIconButton = memo(function NavIconButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
  onCollapse,
  onNavigate,
  onLeaveInsights,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
}) {
  const localize = useLocalize();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        link.onClick(e);
        onNavigate?.();
        return;
      }
      if (isActive && expanded) {
        onCollapse?.();
        return;
      }
      if (!isActive) {
        setActive(link.id);
      }
      if (!expanded) {
        onExpand?.();
      } else {
        onLeaveInsights?.();
      }
    },
    [link, isActive, setActive, expanded, onExpand, onCollapse, onNavigate, onLeaveInsights],
  );

  return (
    <TooltipAnchor
      description={localize(link.title)}
      side="right"
      render={
        <button
          type="button"
          aria-label={localize(link.title)}
          aria-pressed={isActive}
          data-testid={`nav-panel-${link.id}`}
          className={railItemClass}
          onClick={handleClick}
        >
          <link.icon className="size-5" aria-hidden="true" />
        </button>
      }
    />
  );
});

function ExpandedPanel({
  links,
  expanded = true,
  onCollapse,
  onExpand,
  onNavigate,
  onLeaveInsights,
}: {
  links: NavLink[];
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
}) {
  const localize = useLocalize();
  const location = useLocation();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  const isInsightsRoute = location.pathname.startsWith('/insights');

  const toggleLabel = expanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar';
  const toggleClick = expanded ? onCollapse : onExpand;
  const toggleSidebarHint = useShortcutHint('toggleSidebar', localize(toggleLabel));
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');

  return (
    <div className="lc-left-rail flex h-full w-14 flex-shrink-0 flex-col items-center gap-1 border-r py-2.5">
      <Logo className="mb-2 mt-0.5 size-[26px]" />
      <NewChatButton setActive={setActive} />
      <div className="flex flex-col items-center gap-1 overflow-y-auto">
        {links.map((link) => (
          <NavIconButton
            key={link.id}
            link={link}
            isActive={
              link.id === 'insights'
                ? isInsightsRoute
                : !isInsightsRoute && link.id === effectiveActive
            }
            expanded={expanded ?? true}
            setActive={setActive}
            onExpand={onExpand}
            onCollapse={onCollapse}
            onNavigate={onNavigate}
            onLeaveInsights={isInsightsRoute ? onLeaveInsights : undefined}
          />
        ))}
      </div>

      <div className="mt-auto flex flex-col items-center gap-2">
        <TooltipAnchor
          side="right"
          description={toggleSidebarHint}
          render={
            <Button
              id={expanded ? CLOSE_SIDEBAR_ID : undefined}
              data-testid={expanded ? 'close-sidebar-button' : 'open-sidebar-button'}
              size="icon"
              variant="ghost"
              aria-label={localize(toggleLabel)}
              aria-expanded={expanded}
              aria-keyshortcuts={toggleSidebarAriaKey}
              className="lc-rail-item size-10 rounded-[10px]"
              onClick={toggleClick}
            >
              <PanelLeft aria-hidden="true" className="size-5" />
            </Button>
          }
        />
        <Suspense fallback={<Skeleton className="h-9 w-9 rounded-lg" />}>
          <AccountSettings collapsed />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
