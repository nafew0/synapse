import { memo, useCallback, useMemo } from 'react';
import { Sheet, FileText, ScanLine, Presentation } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useChatContext, useChatFormContext } from '~/Providers';
import { useGetStartupConfig } from '~/data-provider';
import { mainTextareaId } from '~/common';
import { useLocalize } from '~/hooks';

type Task = {
  id: string;
  icon: LucideIcon;
  title: TranslationKeys;
  description: TranslationKeys;
  prompt: TranslationKeys;
};

export const TASKS: Task[] = [
  {
    id: 'scan',
    icon: ScanLine,
    title: 'com_ui_task_scan_title',
    description: 'com_ui_task_scan_description',
    prompt: 'com_ui_task_scan_prompt',
  },
  {
    id: 'letter',
    icon: FileText,
    title: 'com_ui_task_letter_title',
    description: 'com_ui_task_letter_description',
    prompt: 'com_ui_task_letter_prompt',
  },
  {
    id: 'slides',
    icon: Presentation,
    title: 'com_ui_task_slides_title',
    description: 'com_ui_task_slides_description',
    prompt: 'com_ui_task_slides_prompt',
  },
  {
    id: 'sheet',
    icon: Sheet,
    title: 'com_ui_task_sheet_title',
    description: 'com_ui_task_sheet_description',
    prompt: 'com_ui_task_sheet_prompt',
  },
];

/**
 * Office tasks on a new chat with the default assistant. A tile fills the
 * composer instead of sending, so the user can finish the sentence or attach
 * the file first.
 */
function TaskTiles() {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const { setValue } = useChatFormContext();
  const { data: startupConfig } = useGetStartupConfig();

  const visible = useMemo(() => {
    const defaultSpec = startupConfig?.modelSpecs?.list?.find((spec) => spec.default);
    if (!defaultSpec || conversation?.spec !== defaultSpec.name) {
      return false;
    }
    return !defaultSpec.conversation_starters?.length;
  }, [startupConfig?.modelSpecs?.list, conversation?.spec]);

  const fillComposer = useCallback(
    (prompt: TranslationKeys) => {
      setValue('text', localize(prompt), { shouldDirty: true });
      const textarea = document.getElementById(mainTextareaId);
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    },
    [localize, setValue],
  );

  if (!visible) {
    return null;
  }

  return (
    <ul
      aria-label={localize('com_ui_task_tiles')}
      className="mx-auto mt-4 grid w-full max-w-3xl grid-cols-2 gap-2 px-4 sm:grid-cols-4 xl:max-w-4xl"
    >
      {TASKS.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            data-testid={`task-tile-${task.id}`}
            onClick={() => fillComposer(task.prompt)}
            className="flex h-full w-full flex-col items-start gap-2 rounded-xl border border-border-light bg-surface-primary p-3 text-left transition-colors duration-theme-fast hover:border-border-heavy hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
          >
            <span className="lc-task-tile-icon flex size-9 items-center justify-center rounded-lg">
              <task.icon className="size-5" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-text-primary">{localize(task.title)}</span>
            <span className="hidden text-xs leading-snug text-text-secondary sm:block">
              {localize(task.description)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default memo(TaskTiles);
