import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { ToastContext } from '@librechat/client';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, dataService, issueReportSchema } from 'librechat-data-provider';
import type { TMessage, TStartupConfig, TIssueReportRequest } from 'librechat-data-provider';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { clearRecentErrors, recordError } from '~/utils/errors';
import en from '~/locales/en/translation.json';
import { resetReported } from '../ReportButton';
import { ReportButton } from '..';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, createIssueReport: jest.fn() },
  };
});

const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CONVO_ID = 'convo-1';

const messages = [
  { messageId: 'm1', isCreatedByUser: true, text: 'first prompt' },
  { messageId: 'm2', isCreatedByUser: false, text: 'answer' },
  { messageId: 'm3', isCreatedByUser: true, text: 'my latest prompt' },
  { messageId: 'm4', isCreatedByUser: false, text: 'failed answer' },
] as TMessage[];

function setup(config: Partial<TStartupConfig> = { issueReportsEnabled: true }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(startupConfigKey(false), config as TStartupConfig);
  queryClient.setQueryData([QueryKeys.messages, CONVO_ID], messages);
  const showToast = jest.fn();
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <ToastContext.Provider value={{ showToast }}>{children}</ToastContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const view = render(
    <ReportButton
      code="service_busy"
      requestId={REQUEST_ID}
      conversationId={CONVO_ID}
      messageId="m4"
    />,
    { wrapper: Wrapper },
  );
  return { ...view, showToast };
}

const httpError = (status: number) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: { status, data: {} },
  });

const sentPayload = (spy: jest.Mock): TIssueReportRequest => spy.mock.calls[0][0];

describe('Report an issue', () => {
  const createSpy = dataService.createIssueReport as jest.Mock;

  beforeEach(() => {
    resetReported();
    clearRecentErrors();
    createSpy.mockReset().mockResolvedValue(undefined);
  });

  it('renders nothing when reporting is disabled', () => {
    setup({ issueReportsEnabled: false });
    expect(screen.queryByRole('button', { name: en.com_ui_report_issue })).toBeNull();
  });

  it('sends a schema-valid payload without the last message by default', async () => {
    const user = userEvent.setup();
    recordError({ code: 'service_busy', requestId: REQUEST_ID });
    const { showToast } = setup();

    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Reference: 0f8fad5b/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(en.com_ui_report_issue_label), 'It broke');
    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue_send }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const payload = sentPayload(createSpy);
    expect(issueReportSchema.safeParse(payload).success).toBe(true);
    expect(payload).toEqual(
      expect.objectContaining({
        description: 'It broke',
        code: 'service_busy',
        requestId: REQUEST_ID,
        conversationId: CONVO_ID,
        messageId: 'm4',
        page: window.location.pathname,
      }),
    );
    expect(payload.lastMessage).toBeUndefined();
    expect(payload.recentErrors).toHaveLength(1);
    expect(payload.client?.userAgent).toBe(navigator.userAgent.slice(0, 512));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: en.com_ui_report_issue_sent, status: 'success' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const reported = screen.getByRole('button', { name: en.com_ui_report_issue_reported });
    expect(reported).toBeDisabled();
  });

  it('attaches the latest user message only when the checkbox is ticked', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue }));
    const checkbox = screen.getByRole('checkbox', {
      name: en.com_ui_report_issue_include_message,
    });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue_send }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const payload = sentPayload(createSpy);
    expect(payload.lastMessage).toBe('my latest prompt');
    expect(issueReportSchema.safeParse(payload).success).toBe(true);
  });

  it('shows the rate-limit toast on 429 and keeps the dialog open', async () => {
    const user = userEvent.setup();
    createSpy.mockRejectedValue(httpError(429));
    const { showToast } = setup();

    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue }));
    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue_send }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: en.com_ui_report_issue_rate_limited }),
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the fallback support email on failure and keeps the typed text', async () => {
    const user = userEvent.setup();
    createSpy.mockRejectedValue(httpError(500));
    setup();

    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue }));
    const field = screen.getByLabelText(en.com_ui_report_issue_label);
    await user.type(field, 'Keep this text');
    await user.click(screen.getByRole('button', { name: en.com_ui_report_issue_send }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('info@bdren.ai');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field).toHaveValue('Keep this text');
  });
});
