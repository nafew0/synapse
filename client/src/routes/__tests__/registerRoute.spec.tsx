import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import Registration from '~/components/Auth/Registration';
import StartupLayout from '~/routes/Layouts/Startup';

/** The startup routes are mounted outside `AuthContextProvider` (see `routes/index.tsx`),
 *  so nothing in this tree may call `useAuthContext`. Only the network boundary is
 *  replaced here; the real `AuthLayout`, `Banner`, `Footer` and `Registration` render. */
/** A populated config so the branches gated on it — social buttons, the email
 *  footer, password rules — render too, rather than short-circuiting to null. */
const startupConfig = {
  appTitle: 'BdREN Synapse',
  emailEnabled: true,
  minPasswordLength: 8,
  serverDomain: 'https://chat.bdren.ai',
  googleLoginEnabled: true,
  openidLoginEnabled: true,
  registrationEnabled: true,
  socialLoginEnabled: true,
};

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: startupConfig, isFetching: false, error: null })),
  useGetBannerQuery: jest.fn(() => ({ data: null })),
  useDismissBannerMutation: jest.fn(() => ({ mutate: jest.fn() })),
  useMarkBannerSeenMutation: jest.fn(() => ({ mutate: jest.fn() })),
}));

const mockRegister = jest.fn();
jest.mock('librechat-data-provider/react-query', () => ({
  useRegisterUserMutation: jest.fn(() => ({ mutate: mockRegister, isLoading: false })),
}));

const router = () =>
  createMemoryRouter(
    [
      {
        path: '/',
        element: <StartupLayout />,
        children: [{ path: 'register', element: <Registration /> }],
      },
    ],
    { initialEntries: ['/register?token=abc123'] },
  );

describe('/register without an AuthContextProvider', () => {
  beforeEach(() => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'not_found' }),
    });
    global.fetch = Object.assign(fetchMock, { preconnect: jest.fn() });
  });

  it('renders the signup form instead of throwing', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <RouterProvider router={router()} />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('form', { name: 'Registration form' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
  });

  /** A dead invitation is known before the visitor submits anything, so it must not be
   *  framed as a failed registration attempt. */
  it('explains an unusable invitation without the failed-submission prefix', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <RouterProvider router={router()} />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/This invitation link is not valid/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/There was an error attempting to register/i),
    ).not.toBeInTheDocument();
  });
});

describe('/register username field', () => {
  /** The invitation may carry a `requestedUsername`, but the account holder chooses their
   *  own handle: the field stays blank and submits fine when left alone. */
  it('is left blank by the invite prefill and does not block submission', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: 'invitee@example.com', name: 'Invitee', username: 'preset' }),
    });
    global.fetch = Object.assign(fetchMock, { preconnect: jest.fn() });
    mockRegister.mockClear();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <RouterProvider router={router()} />
        </RecoilRoot>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue('invitee@example.com'));
    expect(screen.getByLabelText('Username (optional)')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Passw0rd!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'Passw0rd!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit registration' }));

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0][0].username).toBeFalsy();
  });
});
