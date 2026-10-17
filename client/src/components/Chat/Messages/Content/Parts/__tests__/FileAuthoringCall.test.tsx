import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import FileAuthoringCall from '../FileAuthoringCall';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string | number, string>): string => {
      const translations: Record<string, string> = {
        com_ui_created_file: 'Created {{0}}',
        com_ui_creating_file: 'Creating {{0}}',
        com_ui_updated_file: 'Updated {{0}}',
        com_ui_edited_file: 'Edited {{0}}',
        com_ui_editing_file: 'Editing {{0}}',
        com_ui_cancelled: 'Cancelled',
        com_ui_tool_failed: 'failed',
      };
      return (translations[key] ?? key).replace('{{0}}', values?.[0] ?? '');
    },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({
    phase,
    onClick,
    inProgressText,
    finishedText,
  }: {
    phase: 'running' | 'completed' | 'cancelled' | 'failed';
    onClick?: () => void;
    inProgressText: string;
    finishedText: string;
  }) => (
    <button type="button" data-testid="progress-text" onClick={onClick}>
      {phase === 'running' ? inProgressText : finishedText}
    </button>
  ),
}));

jest.mock('../CodeWindowHeader', () => ({
  __esModule: true,
  default: ({ language }: { language: string }) => (
    <div data-testid="code-window-header" data-language={language} />
  ),
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="attachment-group" />,
}));

jest.mock('../useLazyHighlight', () => {
  const { useState, useEffect } = jest.requireActual<typeof import('react')>('react');
  /** Mirrors the real hook's two-phase contract: the render that changed
   *  `code` still shows the previous highlight (or null), and the new
   *  nodes commit in a later passive effect. */
  const useMockLazyHighlight = (code?: string) => {
    const [highlighted, setHighlighted] = useState<string[] | null>(null);
    useEffect(() => {
      setHighlighted(code == null ? null : [code]);
    }, [code]);
    return highlighted;
  };
  return { __esModule: true, default: useMockLazyHighlight };
});

jest.mock('../useToolCallState', () => {
  const { useState } = jest.requireActual<typeof import('react')>('react');
  /** Mirrors the real hook: options object in, a single `phase` out. */
  function useMockToolCallState({
    initialProgress,
    hideDetailsWhileRunning,
    autoExpandDetails,
  }: {
    initialProgress: number;
    hideDetailsWhileRunning?: boolean;
    autoExpandDetails?: boolean;
  }) {
    const [showCode, setShowCode] = useState(
      autoExpandDetails !== false && !(hideDetailsWhileRunning && initialProgress < 1),
    );
    return {
      showCode,
      toggleCode: () => setShowCode((current: boolean) => !current),
      expandStyle: {},
      expandRef: { current: null },
      progress: initialProgress,
      phase: initialProgress < 1 ? 'running' : 'completed',
      hasContent: !(hideDetailsWhileRunning && initialProgress < 1),
    };
  }
  return { __esModule: true, default: useMockToolCallState };
});

describe('FileAuthoringCall', () => {
  it('keeps create_file content hidden while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nUse this skill for testing.',
        }}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Creating SKILL.md');
    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/Use this skill for testing/)).not.toBeInTheDocument();
  });

  it('keeps authored content collapsed after create_file completes', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nLarge generated body stays visible after completion.',
        }}
        output="Created skills/demo/SKILL.md (4096 chars)."
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Created SKILL.md');
    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/Large generated body stays visible/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Created skills/demo/SKILL.md (4096 chars).'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('progress-text'));
    expect(screen.getByTestId('code-window-header')).toHaveAttribute('data-language', 'SKILL.md');
    expect(screen.getByText(/Large generated body stays visible/)).toBeInTheDocument();
    expect(screen.getByText('Created skills/demo/SKILL.md (4096 chars).')).toBeInTheDocument();
  });

  it('labels a create_file overwrite as Updated when the output summary says so', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          content: '# Demo\n\nRevised body.',
        }}
        output="Updated skills/demo/SKILL.md (8302 chars)."
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Updated SKILL.md');
  });

  it('prefers the output diff over the args preview after edit_file completes', () => {
    const output = [
      'Edited skills/demo/SKILL.md (exact match).',
      '',
      '--- skills/demo/SKILL.md',
      '+++ skills/demo/SKILL.md',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ].join('\n');
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'old line',
          new_text: 'new line',
        }}
        output={output}
      />,
    );

    fireEvent.click(screen.getByTestId('progress-text'));

    const preview = screen.getByText((_, element) => element?.tagName.toLowerCase() === 'code');
    expect(preview).toHaveTextContent('-old line');
    expect(preview).toHaveTextContent('+new line');
    expect(screen.queryByText(/--- old_text/)).not.toBeInTheDocument();
  });

  it('shows the attempted input alongside the error output when edit_file fails', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={1}
        isSubmitting={false}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'missing text',
          new_text: 'replacement',
        }}
        output="Error: old_text matched 0 locations in skills/demo/SKILL.md."
      />,
    );

    fireEvent.click(screen.getByTestId('progress-text'));

    const preview = screen.getByText((_, element) => element?.tagName.toLowerCase() === 'code');
    expect(preview).toHaveTextContent('-missing text');
    expect(preview).toHaveTextContent('+replacement');
    expect(screen.getByText(/matched 0 locations/)).toBeInTheDocument();
  });

  it('keeps edit_file replacement args hidden while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          old_text: 'description: Old behavior',
          new_text: 'description: New behavior',
        }}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Editing SKILL.md');
    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/description: Old behavior/)).not.toBeInTheDocument();
  });

  it('hides partial create_file content during run_step_delta', () => {
    render(
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={'{"file_path":"skills/demo/SKILL.md","content":"# Demo\\n\\nStreaming body so far'}
        output=""
      />,
    );

    expect(screen.getByTestId('progress-text')).toHaveTextContent('Creating SKILL.md');
    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/Streaming body so far/)).not.toBeInTheDocument();
  });

  it('hides partial edit_file replacement args while streaming', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={
          '{"file_path":"skills/demo/SKILL.md","old_text":"description: Old behavior","new_text":"description: New beh'
        }
        output=""
      />,
    );

    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/description: Old behavior/)).not.toBeInTheDocument();
  });

  it('hides batched edit previews while streaming', () => {
    const args =
      '{"file_path":"skills/demo/SKILL.md","edits":[' +
      '{"old_text":"first old","new_text":"first new"},' +
      '{"old_text":"second old","new_text":"second n';
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={args}
        output=""
      />,
    );

    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/first old/)).not.toBeInTheDocument();
  });

  it('hides batched edit replacements while the call is in progress', () => {
    render(
      <FileAuthoringCall
        toolName="edit_file"
        initialProgress={0.5}
        isSubmitting={true}
        args={{
          file_path: 'skills/demo/SKILL.md',
          edits: [
            { old_text: 'first old', new_text: 'first new' },
            { old_text: 'second old', new_text: 'second new' },
          ],
        }}
        output=""
      />,
    );

    expect(screen.queryByTestId('code-window-header')).not.toBeInTheDocument();
    expect(screen.queryByText(/first old/)).not.toBeInTheDocument();
  });
});

/**
 * jsdom has no layout, so the capped pane's scroll geometry is stubbed:
 * `clientHeight` is fixed, `scrollHeight` either reads from mutable state
 * or derives from the pane's rendered text (so the async highlight commit
 * measurably changes it), and every `scrollTop` write the component makes
 * is recorded.
 */
const mockScrollMetrics = (
  el: HTMLElement,
  clientHeight: number,
  opts: { deriveHeightFromText?: boolean } = {},
) => {
  const state = { scrollHeight: 0, scrollTop: 0, writes: [] as number[] };
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () =>
      opts.deriveHeightFromText === true ? (el.textContent?.length ?? 0) * 10 : state.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
      state.writes.push(value);
    },
  });
  return state;
};

describe('FileAuthoringCall detail visibility', () => {
  const streamingCreate = (content: string) => (
    <FileAuthoringCall
      toolName="create_file"
      initialProgress={0.5}
      isSubmitting={true}
      args={`{"file_path":"skills/demo/SKILL.md","content":"${content}`}
      output=""
    />
  );

  it('does not mount an authored-content preview while the file is being created', () => {
    const { container, rerender } = render(streamingCreate('# Demo\\nline one'));
    rerender(streamingCreate('# Demo\\nline one\\nline two of the streamed body'));

    expect(container.querySelector('.overflow-auto')).not.toBeInTheDocument();
  });

  it('leaves a finished create_file preview alone', () => {
    const finishedCreate = (content: string) => (
      <FileAuthoringCall
        toolName="create_file"
        initialProgress={1}
        isSubmitting={false}
        args={{ file_path: 'skills/demo/SKILL.md', content }}
        output="Created skills/demo/SKILL.md (4096 chars)."
      />
    );
    const { container, rerender } = render(finishedCreate('# Demo\nline one'));
    fireEvent.click(screen.getByTestId('progress-text'));
    const pane = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(pane, 300);
    state.scrollHeight = 1200;

    rerender(finishedCreate('# Demo\nline one\nline two'));

    expect(state.writes).toHaveLength(0);
  });
});
