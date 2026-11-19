import React from 'react';
import { cn } from '~/utils';

interface ConvoLinkProps {
  isActiveConvo: boolean;
  isPopoverActive: boolean;
  title: string | null;
  onRename: () => void;
  isSmallScreen: boolean;
  /** While the reply streams, the title itself shimmers in place of a spinner. */
  isGenerating?: boolean;
  localize: (key: any, options?: any) => string;
  children: React.ReactNode;
}

const ConvoLink: React.FC<ConvoLinkProps> = ({
  isActiveConvo,
  isPopoverActive,
  title,
  onRename,
  isSmallScreen,
  isGenerating = false,
  localize,
  children,
}) => {
  return (
    <div
      className={cn(
        'flex min-w-0 grow items-center gap-2 rounded-lg px-2',
        isActiveConvo || isPopoverActive ? 'bg-surface-active-alt' : '',
      )}
      title={title ?? undefined}
      aria-current={isActiveConvo ? 'page' : undefined}
      style={{ width: '100%' }}
    >
      {children}
      <div
        className={cn(
          'relative flex-1 grow overflow-hidden whitespace-nowrap',
          isGenerating && 'lc-title-generating',
        )}
        style={{ textOverflow: 'clip' }}
        onDoubleClick={(e) => {
          if (isSmallScreen) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onRename();
        }}
        aria-label={title || localize('com_ui_untitled')}
      >
        {title || localize('com_ui_untitled')}
      </div>
      {isGenerating && <span className="sr-only">{localize('com_ui_generating')}</span>}
    </div>
  );
};

export default ConvoLink;
