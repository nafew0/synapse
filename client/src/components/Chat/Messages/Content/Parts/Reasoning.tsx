import { memo, useMemo, useState, useCallback, useRef, useId } from 'react';
import { useAtomValue } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type { MouseEvent, FocusEvent } from 'react';
import { ThinkingContent, ThinkingButton, FloatingThinkingBar } from './Thinking';
import { useLocalize, useExpandCollapse, useLazyCollapseBody } from '~/hooks';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import { showThinkingAtom } from '~/store/showThinking';
import { useMessageContext } from '~/Providers';
import { useDenseSteps } from './StepRow';
import { cn } from '~/utils';

type ReasoningProps = {
  reasoning: string;
  isLast: boolean;
  reasoningLabel?: string;
};

/**
 * Reasoning Component (MODERN SYSTEM)
 *
 * Used for structured content parts with ContentTypes.THINK type.
 * This handles modern message format where content is an array of typed parts.
 *
 * Pattern: `{ content: [{ type: "think", think: "<think>content</think>" }, ...] }`
 *
 * Used by:
 * - ContentParts.tsx → Part.tsx for structured messages
 * - Agent/Assistant responses (OpenAI Assistants, custom agents)
 * - O-series models (o1, o3) with reasoning capabilities
 * - Modern Claude responses with thinking blocks
 *
 * Key differences from legacy Thinking.tsx:
 * - Works with content parts array instead of plain text
 * - Strips `<think>` tags instead of `:::thinking:::` markers
 * - Each THINK part has its own independent toggle button
 * - Can be interleaved with other content types
 *
 * For legacy text-based messages, see Thinking.tsx component.
 */
const MARKDOWN_MARKS = /[*_`#>]+/g;

/** A thought's first line without markdown, used as its label in an activity block. */
export function summarizeThought(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.replace(MARKDOWN_MARKS, '').replace(/\s+/g, ' ').trim();
}

const Reasoning = memo((props: ReasoningProps) => {
  const { reasoning, isLast, reasoningLabel } = props;
  const contentId = useId();
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const smoothStreaming = useSmoothStreaming();
  const [isExpanded, setIsExpanded] = useState(showThinking);
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(isExpanded);
  const { isSubmitting, isLatestMessage, nextType } = useMessageContext();
  const dense = useDenseSteps();

  // Strip <think> tags from the reasoning content (modern format)
  const reasoningText = useMemo(() => {
    return reasoning
      .replace(/^<think>\s*/, '')
      .replace(/\s*<\/think>$/, '')
      .trim();
  }, [reasoning]);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      mountBody();
      setIsExpanded((prev) => !prev);
    },
    [mountBody],
  );

  const handleFocus = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleBlur = useCallback((e: FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsBarVisible(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsBarVisible(false);
    }
  }, []);

  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;

  const label = useMemo(() => {
    const generated = reasoningLabel?.trim();
    if (generated) {
      return generated;
    }
    const summary = dense ? summarizeThought(reasoningText) : '';
    if (summary) {
      return summary;
    }
    return effectiveIsSubmitting && isLast
      ? localize('com_ui_thinking')
      : localize('com_ui_thoughts');
  }, [dense, effectiveIsSubmitting, isLast, localize, reasoningLabel, reasoningText]);

  if (!reasoningText) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="group/reasoning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="group/thinking-container">
        <div className={dense ? 'my-0.5' : 'mb-2 pb-2 pt-2'}>
          <ThinkingButton
            compact={dense}
            isExpanded={isExpanded}
            onClick={handleClick}
            label={label}
            content={reasoningText}
            contentId={contentId}
            animateLabel={
              smoothStreaming && effectiveIsSubmitting && Boolean(reasoningLabel?.trim())
            }
          />
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          className={cn(nextType !== ContentTypes.THINK && isExpanded && (dense ? 'mb-2' : 'mb-4'))}
          style={expandStyle}
          onTransitionEnd={handleTransitionEnd}
        >
          <div className="relative overflow-hidden" ref={expandRef}>
            {shouldRenderBody && (
              <>
                <ThinkingContent
                  animate={smoothStreaming && effectiveIsSubmitting && isLast && isExpanded}
                >
                  {reasoningText}
                </ThinkingContent>
                <FloatingThinkingBar
                  isVisible={isBarVisible && isExpanded}
                  isExpanded={isExpanded}
                  onClick={handleClick}
                  content={reasoningText}
                  contentId={contentId}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default Reasoning;
