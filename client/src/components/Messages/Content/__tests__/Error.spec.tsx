import React from 'react';
import { RecoilRoot } from 'recoil';
import { ErrorTypes, ViolationTypes, PublicErrorCodes } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ContextType } from 'react';
import translation from '~/locales/en/translation.json';
import { clearRecentErrors, getRecentErrors } from '~/utils/errors';
import { ChatContext } from '~/Providers';
import Error from '../Error';

/**
 * Resolves keys against the real English catalog rather than a stub, so a typed error whose
 * localization key is missing or misspelled fails here instead of reaching users as a raw key.
 */
jest.mock('~/hooks', () => ({
  useGenerationsByLatest: jest.requireActual('~/hooks/useGenerationsByLatest').default,
  useLocalize:
    () =>
    (key: string, options?: Record<string, string>): string => {
      const catalog = jest.requireActual('~/locales/en/translation.json') as Record<string, string>;
      const value = catalog[key] ?? key;
      return options?.[0] != null ? value.replace('{{0}}', options[0]) : value;
    },
}));

jest.mock('~/components/Report', () => ({
  ReportButton: ({ code, requestId }: { code?: string; requestId?: string }) => (
    <button data-testid="report" data-code={code} data-request-id={requestId} />
  ),
}));

const catalog = translation as Record<string, string>;
const requestId = '3f2a9c1e-7b44-4c3e-9a1d-0e5f6a7b8c9d';

type TChat = NonNullable<ContextType<typeof ChatContext>>;

const renderError = (text: string, chat?: Partial<TChat>) =>
  render(
    <RecoilRoot>
      <ChatContext.Provider value={(chat as TChat | undefined) ?? null}>
        <Error text={text} messageId="msg-1" conversationId="convo-1" />
      </ChatContext.Provider>
    </RecoilRoot>,
  );

beforeEach(() => clearRecentErrors());

describe('Error', () => {
  it('renders the generic message for legacy raw provider text', () => {
    const raw =
      'An error occurred while processing the request: 429 Rate limit reached for gpt-x in organization org-abc';
    const { container } = renderError(raw);

    expect(screen.getByText(catalog.com_error_unknown)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/org-abc|gpt-x|429/);
  });

  it('never renders text embedded in a typed error payload', () => {
    const payload = JSON.stringify({ type: ErrorTypes.GOOGLE_ERROR, info: 'gpt-x org-abc' });
    const { container } = renderError(payload);

    expect(screen.getByText(catalog.com_error_unknown)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/org-abc|gpt-x/);
  });

  it('does not name the model or provider for an illegal model request', () => {
    const payload = JSON.stringify({
      type: ViolationTypes.ILLEGAL_MODEL_REQUEST,
      info: 'openAI|gpt-x',
    });
    const { container } = renderError(payload);

    expect(screen.getByText(catalog.com_error_model_unavailable)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/gpt-x|openAI/i);
  });

  it.each([
    [PublicErrorCodes.SERVICE_BUSY, 'com_error_service_busy'],
    [PublicErrorCodes.CONTEXT_TOO_LONG, 'com_error_context_too_long'],
    [PublicErrorCodes.TOOLS_UNAVAILABLE, 'com_error_tools_unavailable'],
    [ErrorTypes.INPUT_LENGTH, 'com_error_context_too_long'],
    [ErrorTypes.REFUSAL, 'com_error_content_filtered'],
    ['concurrent', 'com_error_concurrent'],
    ['message_limit', 'com_error_message_limit'],
    [ViolationTypes.BAN, 'com_error_ban'],
    [ViolationTypes.TOKEN_BALANCE, 'com_error_token_balance'],
    ['insufficient_quota', 'com_error_model_unavailable'],
  ])('maps %s to %s', (code, key) => {
    renderError(JSON.stringify({ type: code }));
    expect(screen.getByText(catalog[key])).toBeInTheDocument();
  });

  it('renders the localized copy for a rejected Google video', () => {
    renderError(JSON.stringify({ type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE }));
    expect(screen.getByText(catalog.com_error_google_video_unprocessable)).toBeInTheDocument();
  });

  it('replaces LangChain model-not-found attribution with the model-unavailable text', () => {
    const raw =
      'An error occurred while processing the request: 404 404 page not found Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_NOT_FOUND/';
    const { container } = renderError(raw);

    expect(screen.getByText(catalog.com_error_model_unavailable)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/langchain/i);
  });

  it('shows the short reference and passes the request id to the report button', () => {
    renderError(JSON.stringify({ type: PublicErrorCodes.SERVICE_BUSY, requestId }));

    expect(screen.getByText('Reference: 3f2a9c1e')).toBeInTheDocument();
    const report = screen.getByTestId('report');
    expect(report).toHaveAttribute('data-code', PublicErrorCodes.SERVICE_BUSY);
    expect(report).toHaveAttribute('data-request-id', requestId);
  });

  it('omits the reference when there is no request id', () => {
    renderError(JSON.stringify({ type: PublicErrorCodes.SERVICE_BUSY }));
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  it('records the error once for issue reports', () => {
    renderError(JSON.stringify({ type: PublicErrorCodes.SERVICE_BUSY, requestId }));
    expect(getRecentErrors()).toEqual([
      expect.objectContaining({ code: PublicErrorCodes.SERVICE_BUSY, requestId }),
    ]);
  });

  it('hides "Try again" outside a chat', () => {
    renderError(JSON.stringify({ type: PublicErrorCodes.UNKNOWN }));
    expect(screen.queryByText(catalog.com_ui_try_again)).not.toBeInTheDocument();
  });

  it('regenerates the failed response on "Try again"', () => {
    const failed = { messageId: 'msg-1', parentMessageId: 'user-1', isCreatedByUser: false };
    const regenerate = jest.fn();
    renderError(JSON.stringify({ type: PublicErrorCodes.UNKNOWN }), {
      regenerate,
      isSubmitting: false,
      conversation: { endpoint: 'agents' } as TChat['conversation'],
      getMessages: () => [failed] as ReturnType<TChat['getMessages']>,
    });

    fireEvent.click(screen.getByText(catalog.com_ui_try_again));
    expect(regenerate).toHaveBeenCalledWith(failed, expect.any(Object));
  });

  it('hides "Try again" while a response is streaming', () => {
    renderError(JSON.stringify({ type: PublicErrorCodes.UNKNOWN }), {
      regenerate: jest.fn(),
      isSubmitting: true,
      conversation: { endpoint: 'agents' } as TChat['conversation'],
      getMessages: () => [],
    });
    expect(screen.queryByText(catalog.com_ui_try_again)).not.toBeInTheDocument();
  });
});
