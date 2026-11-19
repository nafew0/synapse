import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts, Agents } from 'librechat-data-provider';
import { officeAssistantAgentId } from '~/components/OfficeAssistantAvatar';

const QUESTION_TOOL = 'ask_user_question';

const partText = (part: TMessageContentParts): string => {
  const text = (part as { text?: string | { value?: string } }).text;
  return (typeof text === 'string' ? text : text?.value) ?? '';
};

/**
 * Blanks text an assistant wrote between tool calls, for display only: the stored message and the
 * model's history keep it. Text before a question stays, since it introduces the question. A run
 * that stopped on a tool call has no final reply, so its last note stays once streaming ends.
 * Returns the same array when nothing is hidden, so memoized consumers do not re-render.
 */
export function hideWorkNotes<T extends TMessageContentParts | undefined>(
  content: T[] | undefined,
  isStreaming: boolean,
): T[] | undefined {
  if (!content) {
    return content;
  }
  let hidden: T[] | undefined;
  let nextTool: string | undefined;
  let keepLastNote = !isStreaming;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const part = content[i];
    if (part == null) {
      continue;
    }
    if (part.type === ContentTypes.TOOL_CALL) {
      nextTool = (part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.name ?? '';
      continue;
    }
    if (part.type !== ContentTypes.TEXT || partText(part).length === 0) {
      continue;
    }
    if (nextTool === undefined) {
      keepLastNote = false;
      continue;
    }
    if (nextTool === QUESTION_TOOL) {
      continue;
    }
    if (keepLastNote) {
      keepLastNote = false;
      continue;
    }
    hidden = hidden ?? content.slice();
    hidden[i] = { ...part, text: '', tool_call_ids: [] } as T;
  }
  return hidden ?? content;
}

/** Only the Office Assistant's notes are hidden; other assistants' messages pass through. */
export const hideOfficeWorkNotes = <T extends TMessageContentParts | undefined>(
  model: string | null | undefined,
  content: T[] | undefined,
  isStreaming: boolean,
): T[] | undefined =>
  model === officeAssistantAgentId ? hideWorkNotes(content, isStreaming) : content;
