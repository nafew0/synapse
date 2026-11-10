import React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent, screen } from '@testing-library/react';
import type { ChatFormValues } from '~/common';
import { ChatFormProvider, useChatFormContext } from '~/Providers';
import { mainTextareaId } from '~/common';

const mockConversation: { spec?: string } = { spec: 'office-assistant' };
const mockSpecs: { list: { name: string; default?: boolean; conversation_starters?: string[] }[] } =
  { list: [] };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { modelSpecs: mockSpecs } }),
}));

jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers'),
  useChatContext: () => ({ conversation: mockConversation }),
}));

import TaskTiles from '../TaskTiles';

function ComposerValue() {
  const { control } = useChatFormContext();
  const text = useWatch({ control, name: 'text' });
  return <output data-testid="composer-value">{text}</output>;
}

function Harness() {
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  return (
    <ChatFormProvider {...methods}>
      <textarea id={mainTextareaId} aria-label="message" />
      <TaskTiles />
      <ComposerValue />
    </ChatFormProvider>
  );
}

describe('TaskTiles', () => {
  beforeEach(() => {
    mockConversation.spec = 'office-assistant';
    mockSpecs.list = [
      { name: 'office-assistant', default: true },
      { name: 'gpt', default: false },
    ];
  });

  it('shows the four office tasks for the default assistant', () => {
    render(<Harness />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByText('com_ui_task_scan_title')).toBeInTheDocument();
  });

  it('fills the composer instead of sending, and focuses it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('task-tile-letter'));
    expect(screen.getByTestId('composer-value')).toHaveTextContent('com_ui_task_letter_prompt');
    expect(document.activeElement?.id).toBe(mainTextareaId);
  });

  it('tags each tile with its task so the hover motion finds its icon', () => {
    render(<Harness />);
    const tasks = screen.getAllByRole('button').map((tile) => tile.getAttribute('data-task'));
    expect(tasks).toEqual(['scan', 'letter', 'slides', 'sheet']);
    screen.getAllByRole('button').forEach((tile) => {
      expect(tile).toHaveClass('lc-task-tile');
      expect(tile.querySelector('svg')).toBeInTheDocument();
    });
  });

  it('stays hidden for other models', () => {
    mockConversation.spec = 'gpt';
    render(<Harness />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('gives way to configured conversation starters', () => {
    mockSpecs.list = [{ name: 'office-assistant', default: true, conversation_starters: ['Hi'] }];
    render(<Harness />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
