import { memo, useCallback, lazy, Suspense } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { PanelLeft, SquarePen } from 'lucide-react';
import { Skeleton, Button, TooltipAnchor } from '@librechat/client';
import type { TranslationKeys } from '~/hooks';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { Logo } from '~/components/Brand';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import store from '~/store';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

/** One-word names shown under rail icons; the full title stays the tooltip and accessible name. */
const RAIL_LABELS: Record<string, TranslationKeys> = {
  conversations: 'com_nav_rail_chats',
  skills: 'com_ui_skills',
  prompts: 'com_ui_prompts',
  memories: 'com_nav_rail_memory',
  files: 'com_nav_rail_files',
  agents: 'com_nav_rail_agents',
  assistants: 'com_nav_rail_assistants',
  bookmarks: 'com_nav_rail_bookmarks',
  parameters: 'com_nav_rail_parameters',
  'mcp-builder': 'com_nav_rail_mcp',
  insights: 'com_insights_navigation',
};

const railItemClass =
  'lc-rail-item flex w-[58px] flex-col items-center gap-[3px] rounded-[10px] pb-1.5 pt-1 text-[11px] font-medium leading-none';
const railPillClass =
  'lc-rail-pill flex h-7 w-10 items-center justify-center rounded-full transition-colors';

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
          className="lc-rail-item mb-1.5 flex w-[58px] flex-col items-center gap-[3px] text-[11px] font-semibold leading-none"
          onClick={handleNewChatClick}
        >
          <span className="lc-rail-new flex size-9 items-center justify-center rounded-[10px] transition-colors">
            <SquarePen className="size-[18px]" aria-hidden="true" />
          </span>
          <span aria-hidden="true">{localize('com_nav_rail_new')}</span>
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
          <span className={railPillClass}>
            <link.icon className="size-5" aria-hidden="true" />
          </span>
          <span aria-hidden="true" className="max-w-full truncate whitespace-nowrap px-0.5">
            {localize(RAIL_LABELS[link.id] ?? link.title)}
          </span>
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
    <div className="lc-left-rail flex h-full w-16 flex-shrink-0 flex-col items-center gap-1 border-r py-2.5">
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
              className="lc-rail-toggle size-10 rounded-[10px]"
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
