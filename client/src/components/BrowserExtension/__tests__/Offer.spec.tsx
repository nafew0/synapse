import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Offer from '../Offer';

const mockCode = {
  mutate: jest.fn(),
  isLoading: false,
  isError: false,
  data: { code: 'ABCD-EFGH', expiresAt: '2026-11-20T10:00:00Z' } as unknown,
};
const mockToast = jest.fn();
const mockUser = { id: 'u-b', name: 'Bushra', email: 'b@pilot.test' };

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  useToastContext: () => ({ showToast: mockToast }),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useLocalize: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));
jest.mock('~/data-provider', () => ({
  useBrowserExtensionCode: () => mockCode,
}));

type Request = { source?: string; id?: string; type?: string; code?: string; reply?: unknown };

/** The extension's bridge on the page: it marks the document and answers what the page posts. */
function fakeBridge(replies: Record<string, unknown>) {
  document.documentElement.dataset.synapseBrowser = '1.0.0';
  const asked: Request[] = [];
  const listener = (event: MessageEvent) => {
    const data = event.data as Request;
    if (data?.source !== 'synapse-browser' || !data.type || 'reply' in data) return;
    asked.push(data);
    window.postMessage(
      { source: 'synapse-browser', id: data.id, reply: replies[data.type] },
      window.location.origin,
    );
  };
  window.addEventListener('message', listener);
  return {
    asked,
    stop: () => {
      window.removeEventListener('message', listener);
      delete document.documentElement.dataset.synapseBrowser;
    },
  };
}

const ping = (extra: Record<string, unknown>) => ({
  installed: true,
  version: '1.0.0',
  enabled: true,
  ...extra,
});

/** jsdom posts window messages without an origin unless one is given: the page and the bridge must agree on it. */
const realPost = window.postMessage.bind(window);
beforeAll(() => {
  window.postMessage = ((message: unknown) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: message,
        origin: window.location.origin,
        source: window,
      }),
    )) as typeof window.postMessage;
});
afterAll(() => {
  window.postMessage = realPost;
});

describe('the offer to connect Synapse Browser', () => {
  let bridge: ReturnType<typeof fakeBridge> | undefined;
  beforeEach(() => {
    mockCode.mutate.mockClear();
    mockToast.mockClear();
    mockCode.isError = false;
    window.localStorage.clear();
  });
  afterEach(() => bridge?.stop());

  it('offers to connect a browser that is not, and sends the code with the click', async () => {
    bridge = fakeBridge({
      ping: ping({ connected: false }),
      connect: { ok: true, account: mockUser },
    });
    render(<Offer />);
    expect(await screen.findByText(/com_ui_browser_ext_offer_connect_body Bushra/)).toBeTruthy();
    expect(mockCode.mutate).toHaveBeenCalled();
    fireEvent.click(screen.getByText('com_ui_browser_ext_offer_connect'));
    await waitFor(() =>
      expect(bridge?.asked.find((m) => m.type === 'connect')?.code).toBe('ABCD-EFGH'),
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' })),
    );
  });

  it('offers to switch a browser that acts as someone else, naming both', async () => {
    bridge = fakeBridge({
      ping: ping({ connected: true, account: { id: 'u-a', name: 'Arif', email: '' } }),
    });
    render(<Offer />);
    expect(
      await screen.findByText(/com_ui_browser_ext_offer_switch_body Arif Bushra/),
    ).toBeTruthy();
    expect(screen.getByText('com_ui_browser_ext_offer_switch')).toBeTruthy();
  });

  it('says nothing when the extension already acts as this user', async () => {
    bridge = fakeBridge({
      ping: ping({ connected: true, account: { id: 'u-b', name: 'Bushra' } }),
    });
    render(<Offer />);
    await waitFor(() => expect(bridge?.asked.some((m) => m.type === 'ping')).toBe(true));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('stays away once dismissed, for that user and that account', async () => {
    bridge = fakeBridge({ ping: ping({ connected: false }) });
    const { unmount } = render(<Offer />);
    fireEvent.click(await screen.findByText('com_ui_browser_ext_offer_later'));
    expect(screen.queryByRole('heading')).toBeNull();
    unmount();
    render(<Offer />);
    await waitFor(() => expect(bridge?.asked.filter((m) => m.type === 'ping').length).toBe(2));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('offers nothing where the server gives no codes, such as with browser tasks off', async () => {
    mockCode.isError = true;
    bridge = fakeBridge({ ping: ping({ connected: false }) });
    render(<Offer />);
    await waitFor(() => expect(bridge?.asked.some((m) => m.type === 'ping')).toBe(true));
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
