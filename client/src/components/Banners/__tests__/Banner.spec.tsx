import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TBanner } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { AuthContext } from '~/hooks/AuthContext';
import { Banner } from '../Banner';

const mockGetBanner = jest.fn();
const mockMarkBannerSeen = jest.fn();
const mockDismissBanner = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getBanner: () => mockGetBanner(),
      markBannerSeen: (bannerId: string) => mockMarkBannerSeen(bannerId),
      dismissBanner: (bannerId: string) => mockDismissBanner(bannerId),
    },
  };
});

const baseBanner: TBanner = {
  bannerId: 'gemini-38',
  type: 'banner',
  title: 'Gemini 3.8 Flash is here',
  message: 'Faster answers at a <b>lower</b> cost.',
  category: 'feature',
  display: 'once',
  linkLabel: 'Try it',
  linkUrl: '/c/new',
  displayFrom: '2026-09-10T00:00:00.000Z',
  displayTo: null,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  isPublic: true,
  persistable: false,
};

const signedIn: Partial<TAuthContext> = {
  isAuthenticated: true,
  user: { id: 'user-1' } as TAuthContext['user'],
};
const anonymous: Partial<TAuthContext> = { isAuthenticated: false, user: undefined };

function renderBanner(auth: Partial<TAuthContext>, onHeightChange?: (height: number) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContext.Provider value={auth as TAuthContext}>
            <Banner onHeightChange={onHeightChange} />
          </AuthContext.Provider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockMarkBannerSeen.mockResolvedValue(undefined);
  mockDismissBanner.mockResolvedValue(undefined);
});

describe('Banner (bar)', () => {
  it('renders nothing when there is no active banner', async () => {
    mockGetBanner.mockResolvedValue(null);
    const { container } = renderBanner(signedIn);
    await waitFor(() => expect(mockGetBanner).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the category chip, title, sanitized message and link', async () => {
    mockGetBanner.mockResolvedValue(baseBanner);
    renderBanner(signedIn);

    const region = await screen.findByRole('region', { name: 'Announcement' });
    expect(region).toHaveTextContent('New');
    expect(screen.getByText('Gemini 3.8 Flash is here')).toBeInTheDocument();
    expect(region.querySelector('b')).toHaveTextContent('lower');
    expect(screen.getByRole('link', { name: 'Try it →' })).toHaveAttribute('href', '/c/new');
  });

  it('records a signed-in view of a once banner exactly once and keeps it visible', async () => {
    mockGetBanner.mockResolvedValue(baseBanner);
    renderBanner(signedIn);

    await screen.findByRole('region', { name: 'Announcement' });
    await waitFor(() => expect(mockMarkBannerSeen).toHaveBeenCalledTimes(1));
    expect(mockMarkBannerSeen).toHaveBeenCalledWith('gemini-38');
    expect(screen.getByRole('region', { name: 'Announcement' })).toBeInTheDocument();
  });

  it('does not record a view for until_dismissed banners, and dismissing hides it', async () => {
    mockGetBanner.mockResolvedValue({ ...baseBanner, display: 'until_dismissed' });
    const onHeightChange = jest.fn();
    renderBanner(signedIn, onHeightChange);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss announcement' }));

    await waitFor(() => expect(mockDismissBanner).toHaveBeenCalledWith('gemini-38'));
    expect(mockMarkBannerSeen).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Announcement' })).not.toBeInTheDocument();
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
  });

  it('has no dismiss button for always banners', async () => {
    mockGetBanner.mockResolvedValue({ ...baseBanner, category: 'outage', display: 'always' });
    renderBanner(signedIn);

    const region = await screen.findByRole('region', { name: 'Announcement' });
    expect(region).toHaveTextContent('Outage');
    expect(screen.queryByRole('button', { name: 'Dismiss announcement' })).not.toBeInTheDocument();
  });

  it('shows a once banner to an anonymous visitor on one visit only', async () => {
    mockGetBanner.mockResolvedValue(baseBanner);
    const first = renderBanner(anonymous);
    await screen.findByRole('region', { name: 'Announcement' });
    await waitFor(() => expect(localStorage.getItem('hideBannerHint')).toContain('gemini-38'));
    expect(mockMarkBannerSeen).not.toHaveBeenCalled();
    first.unmount();

    renderBanner(anonymous);
    await waitFor(() => expect(mockGetBanner).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Announcement' })).not.toBeInTheDocument();
  });
});

describe('Banner (floating card)', () => {
  const cardBanner: TBanner = { ...baseBanner, type: 'popup' };

  it('renders a card with the call to action, and does not push the layout down', async () => {
    mockGetBanner.mockResolvedValue(cardBanner);
    const onHeightChange = jest.fn();
    renderBanner(signedIn, onHeightChange);

    const card = await screen.findByRole('region', { name: 'Announcement' });
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveTextContent('New');
    expect(screen.getByRole('heading', { name: 'Gemini 3.8 Flash is here' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try it' })).toHaveAttribute('href', '/c/new');
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(onHeightChange.mock.calls.every(([height]) => height === 0)).toBe(true);
    await waitFor(() => expect(mockMarkBannerSeen).toHaveBeenCalledWith('gemini-38'));
  });

  it('"Got it" closes the card and records the dismissal', async () => {
    mockGetBanner.mockResolvedValue(cardBanner);
    renderBanner(signedIn);

    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));

    await waitFor(() => expect(mockDismissBanner).toHaveBeenCalledWith('gemini-38'));
    expect(screen.queryByRole('region', { name: 'Announcement' })).not.toBeInTheDocument();
  });

  it('following the call to action also closes the card', async () => {
    mockGetBanner.mockResolvedValue({ ...cardBanner, display: 'until_dismissed' });
    renderBanner(signedIn);

    fireEvent.click(await screen.findByRole('link', { name: 'Try it' }));

    await waitFor(() => expect(mockDismissBanner).toHaveBeenCalledWith('gemini-38'));
    expect(screen.queryByRole('region', { name: 'Announcement' })).not.toBeInTheDocument();
  });

  it('an always card has no way to close it', async () => {
    mockGetBanner.mockResolvedValue({ ...cardBanner, category: 'outage', display: 'always' });
    renderBanner(signedIn);

    const card = await screen.findByRole('region', { name: 'Announcement' });
    expect(card).toHaveTextContent('Outage');
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss announcement' })).not.toBeInTheDocument();
  });
});
