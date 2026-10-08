import React from 'react';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { clearRecentErrors, getRecentErrors } from '~/utils/errors';
import RouteErrorBoundary from '../RouteErrorBoundary';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Report', () => ({
  ReportButton: ({ code }: { code?: string }) => <button data-testid="report" data-code={code} />,
}));

const SECRET = 'Cannot read properties of undefined at http://rag_api:8000 org-abc';

function Crash(): JSX.Element {
  throw new Error(SECRET);
}

const renderCrash = () => {
  const router = createMemoryRouter([
    { path: '/', element: <Crash />, errorElement: <RouteErrorBoundary /> },
  ]);
  return render(<RouterProvider router={router} />);
};

describe('RouteErrorBoundary', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearRecentErrors();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  it('shows a friendly page without the stack or message outside development', () => {
    process.env.NODE_ENV = 'production';
    const { container } = renderCrash();

    expect(screen.getByText('com_error_page_title')).toBeInTheDocument();
    expect(screen.getByText('com_error_page_body')).toBeInTheDocument();
    expect(screen.getByText('com_ui_reload')).toBeInTheDocument();
    expect(screen.getByText('com_ui_go_home')).toBeInTheDocument();
    expect(screen.getByTestId('report')).toHaveAttribute('data-code', 'unknown');
    expect(screen.queryByText('com_ui_stack_trace')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_download_error_logs')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/rag_api|org-abc/);
  });

  it('records the crash for issue reports', () => {
    process.env.NODE_ENV = 'production';
    renderCrash();
    expect(getRecentErrors()).toEqual([expect.objectContaining({ code: 'unknown' })]);
  });

  it('shows the error details in development', () => {
    process.env.NODE_ENV = 'development';
    renderCrash();

    expect(screen.getByText('com_ui_stack_trace')).toBeInTheDocument();
    expect(screen.getByText('com_ui_download_error_logs')).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });
});
