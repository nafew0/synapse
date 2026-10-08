import { useState, useMemo, useCallback } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@librechat/client';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface ContentBlock {
  type?: string;
  text?: string;
}

const ERROR_PREFIX = /^Error:\s*(\[.*?\]\s*)*tool call failed:\s*/i;

export function isError(text: string): boolean {
  return ERROR_PREFIX.test(text) || text.startsWith('Error processing tool');
}

function isStructuredText(text: string): boolean {
  return text.includes('\n') || text.includes('{') || text.includes(':');
}

interface ExtractedText {
  text: string;
  error: boolean;
  /** When true, `text` contains raw JSON that should be rendered as a highlighted code block. */
  isJson: boolean;
}

function extractText(raw: string): ExtractedText {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', error: false, isJson: false };
  }

  if (isError(trimmed)) {
    return { text: '', error: true, isJson: false };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const textBlocks = parsed.filter(
          (b: ContentBlock) => typeof b === 'object' && b !== null && typeof b.text === 'string',
        );
        if (textBlocks.length > 0) {
          const joined = (textBlocks as ContentBlock[])
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (isError(joined)) {
            return { text: '', error: true, isJson: false };
          }
          return { text: joined, error: false, isJson: false };
        }
      }

      // Render structured JSON as a highlighted code block
      return {
        text: JSON.stringify(parsed, null, 2),
        error: false,
        isJson: true,
      };
    } catch {
      // Not JSON
    }
  }

  return { text: trimmed, error: false, isJson: false };
}

const TRUNCATE_LINES = 20;
const VISIBLE_LINES = 15;

interface OutputRendererProps {
  text: string;
}

export default function OutputRenderer({ text }: OutputRendererProps) {
  const localize = useLocalize();
  const { text: displayText, error, isJson } = useMemo(() => extractText(text), [text]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(displayText, { format: 'text/plain' });
    setTimeout(() => setIsCopied(false), 3000);
  }, [displayText]);

  if (error) {
    return (
      <p role="status" className="text-sm text-text-secondary">
        {localize('com_error_tool_failed')}
      </p>
    );
  }

  if (!displayText) {
    return null;
  }

  const lines = displayText.split('\n');
  const needsTruncation = lines.length > TRUNCATE_LINES;
  const visibleText =
    needsTruncation && !isExpanded ? lines.slice(0, VISIBLE_LINES).join('\n') : displayText;
  const structured = !isJson && isStructuredText(displayText);

  return (
    <div className="relative">
      {isJson ? (
        <pre className="max-h-[300px] overflow-auto rounded text-xs">
          <code className="hljs language-json !whitespace-pre-wrap !break-words">
            {visibleText}
          </code>
        </pre>
      ) : (
        <pre
          className={cn(
            'max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-xs',
            structured && 'font-mono text-text-secondary',
            !structured && 'font-sans text-sm text-text-primary',
          )}
        >
          {visibleText}
        </pre>
      )}
      <div className="absolute bottom-0 right-0">
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          iconOnly
          label={localize('com_ui_copy')}
        />
      </div>
      {needsTruncation && (
        <Button
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? localize('com_ui_show_less') : localize('com_ui_show_more')}
        </Button>
      )}
    </div>
  );
}
