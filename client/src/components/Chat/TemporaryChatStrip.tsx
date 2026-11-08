import { memo } from 'react';
import { MessageCircleDashed } from 'lucide-react';
import useTemporaryChat from '~/hooks/Chat/useTemporaryChat';
import { useLocalize } from '~/hooks';

/**
 * A mint strip under the header while a chat is temporary. It names the mode in words and,
 * before the chat starts, offers a way out next to the explanation.
 */
function TemporaryChatStrip() {
  const localize = useLocalize();
  const { show, isTemporary, toggle } = useTemporaryChat();

  if (!isTemporary) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="temporary-chat-strip"
      className="lc-temp-strip absolute inset-x-0 top-[52px] z-10 flex items-center gap-2 px-4 py-2 text-sm font-medium"
    >
      <MessageCircleDashed className="size-4 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{localize('com_ui_temporary_strip')}</span>
      {show && (
        <button
          type="button"
          onClick={toggle}
          className="ml-auto flex-shrink-0 rounded-md px-1 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          {localize('com_ui_temporary_turn_off')}
        </button>
      )}
    </div>
  );
}

export default memo(TemporaryChatStrip);
