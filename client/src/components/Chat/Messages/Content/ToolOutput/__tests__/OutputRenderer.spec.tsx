import React from 'react';
import { render, screen } from '@testing-library/react';
import OutputRenderer from '../OutputRenderer';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('OutputRenderer', () => {
  it('shows the generic tool failure text instead of the raw error', () => {
    const raw =
      'Error: [mcp] tool call failed: Error POSTing to endpoint (HTTP 500): connect ECONNREFUSED http://rag_api:8000 org-abc';
    const { container } = render(<OutputRenderer text={raw} />);

    expect(screen.getByText('com_error_tool_failed')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/rag_api|ECONNREFUSED|org-abc|HTTP 500/);
    expect(screen.queryByText('com_ui_details')).not.toBeInTheDocument();
  });

  it('hides errors wrapped in content blocks', () => {
    const raw = JSON.stringify([
      { type: 'text', text: 'Error processing tool web_search: 401 key sk-abc' },
    ]);
    const { container } = render(<OutputRenderer text={raw} />);

    expect(screen.getByText('com_error_tool_failed')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/sk-abc|401/);
  });

  it('still renders normal tool output', () => {
    render(<OutputRenderer text="The weather is sunny" />);
    expect(screen.getByText('The weather is sunny')).toBeInTheDocument();
  });
});
