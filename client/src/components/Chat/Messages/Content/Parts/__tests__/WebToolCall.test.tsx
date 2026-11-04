import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import WebToolCall from '../WebToolCall';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, string | number>): string => {
      const translations: Record<string, string> = {
        com_ui_web_searching: 'Searching the web',
        com_ui_web_searched: 'Searched the web',
        com_ui_web_search_failed: "Couldn't search the web",
        com_ui_web_page_reading: 'Reading a web page',
        com_ui_web_page_read: 'Read a web page',
        com_ui_web_page_read_named: `Read ${values?.[0]}`,
        com_ui_web_page_read_failed: "Couldn't read the page",
        com_ui_web_search_sources: `${values?.count} sources`,
      };
      return translations[key] ?? key;
    },
  useProgress: (progress: number) => (progress >= 1 ? 1 : progress),
  useToolDetails: () => false,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
}));

const searchOutput = [
  '1. BdREN Annual Report 2025',
  'URL: https://www.bdren.net.bd/report',
  'Connectivity grew across 200 institutions.',
  '',
  '2. Research networks in South Asia',
  'URL: https://example.org/asia',
  'A survey of NRENs.',
].join('\n');

const renderCall = (props: Partial<React.ComponentProps<typeof WebToolCall>>) =>
  render(
    <RecoilRoot>
      <WebToolCall
        name="search_web"
        args='{"query":"bdren annual report","limit":5,"country":"BD"}'
        initialProgress={1}
        isSubmitting={false}
        {...props}
      />
    </RecoilRoot>,
  );

describe('WebToolCall', () => {
  it('shows a finished search as a label with its sources, never the snippets or settings', () => {
    const { container } = renderCall({ output: searchOutput });

    const toggle = screen.getByRole('button', { name: /Searched the web - 2 sources/ });
    fireEvent.click(toggle);

    expect(screen.getByRole('link', { name: /BdREN Annual Report 2025/ })).toHaveAttribute(
      'href',
      'https://www.bdren.net.bd/report',
    );
    expect(screen.getByRole('link', { name: /Research networks in South Asia/ })).toBeVisible();
    expect(container.textContent).not.toContain('Connectivity grew');
    expect(container.textContent).not.toContain('bdren annual report');
    expect(container.textContent).not.toContain('country');
  });

  it('labels a search with no results without a toggle', () => {
    renderCall({ output: 'No results found for "x".' });
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a page read as a link to the page, never its text', () => {
    const { container } = renderCall({
      name: 'read_web_page',
      args: '{"url":"https://bdren.net.bd/tariffs"}',
      output: '# Tariffs 2026\nURL: https://bdren.net.bd/tariffs\n\nThe full page text.',
    });

    expect(screen.getByRole('link', { name: /Read Tariffs 2026/ })).toHaveAttribute(
      'href',
      'https://bdren.net.bd/tariffs',
    );
    expect(container.textContent).not.toContain('The full page text');
  });

  it('labels the former tool ids the same way', () => {
    renderCall({ name: 'firecrawl_search', output: searchOutput });
    expect(screen.getByRole('button', { name: /Searched the web/ })).toBeInTheDocument();
  });

  it('says a step failed without showing the error', () => {
    const { container } = renderCall({
      output: 'Error processing tool search_web: Web request failed with status 402',
    });
    expect(screen.getByText("Couldn't search the web")).toBeInTheDocument();
    expect(container.textContent).not.toContain('402');
  });

  it('shows the model label while a read is running', () => {
    renderCall({
      name: 'read_web_page',
      args: '{"intent":"Reading the tariff page","url":"https://a.org"}',
      output: '',
      initialProgress: 0.5,
      isSubmitting: true,
    });
    expect(screen.getByText('Reading the tariff page')).toBeInTheDocument();
  });
});
