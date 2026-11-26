import type { TStartupConfig } from 'librechat-data-provider';
import { render, screen } from 'test/layout-test-utils';
import * as endpointQueries from '~/data-provider/Endpoints/queries';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import * as authMutations from '~/data-provider/Auth/mutations';
import * as authQueries from '~/data-provider/Auth/queries';
import AuthLayout from '~/components/Auth/AuthLayout';
import { markExplicitLogout, wasExplicitLogout } from '~/utils';
import Login from '~/components/Auth/Login';

jest.mock('librechat-data-provider/react-query');
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  __esModule: true,
  useOutletContext: () => ({ startupConfig: mockSsoOnlyConfig }),
}));

/** What the server sends with SSO-only on (`ssoOnlyStartupFields`). */
const mockSsoOnlyConfig = {
  ssoOnly: true,
  socialLogins: ['openid'],
  discordLoginEnabled: false,
  facebookLoginEnabled: false,
  githubLoginEnabled: false,
  googleLoginEnabled: false,
  appleLoginEnabled: false,
  samlLoginEnabled: false,
  openidLoginEnabled: true,
  openidLabel: 'Continue with OpenID',
  openidAutoRedirect: true,
  registrationEnabled: false,
  emailLoginEnabled: false,
  passwordResetEnabled: false,
  socialLoginEnabled: true,
  serverDomain: 'mock-server',
} as unknown as TStartupConfig;

function setup(path = '/login') {
  window.history.replaceState({}, '', path);
  jest
    .spyOn(authMutations, 'useLoginUserMutation')
    //@ts-ignore - only the fields the page reads
    .mockReturnValue({ isLoading: false, isError: false, mutate: jest.fn() });
  jest
    .spyOn(authMutations, 'useRefreshTokenMutation')
    //@ts-ignore - only the fields the page reads
    .mockReturnValue({ isLoading: false, isError: false, mutate: jest.fn() });
  jest
    .spyOn(authQueries, 'useGetUserQuery')
    //@ts-ignore - only the fields the page reads
    .mockReturnValue({ isLoading: false, isError: false, data: {} });
  jest
    .spyOn(endpointQueries, 'useGetStartupConfig')
    //@ts-ignore - only the fields the page reads
    .mockReturnValue({
      isFetching: false,
      isLoading: false,
      isError: false,
      data: mockSsoOnlyConfig,
    });
  jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - only the fields the page reads
    .mockReturnValue({ isLoading: false, isError: false, data: {} });

  return render(
    <AuthLayout
      startupConfig={mockSsoOnlyConfig}
      isFetching={false}
      error={null}
      startupConfigError={null}
      header="Welcome back"
      pathname="login"
    >
      <Login />
    </AuthLayout>,
  );
}

const expectOnlyBdrenSignIn = () => {
  const links = screen.getAllByRole('link');
  expect(links.every((link) => link.getAttribute('href') === 'mock-server/oauth/openid')).toBe(
    true,
  );
  expect(screen.getAllByRole('link', { name: /Sign in with BDREN/i }).length).toBeGreaterThan(0);
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Sign up/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/Forgot/i)).not.toBeInTheDocument();
};

afterEach(() => {
  sessionStorage.clear();
  jest.restoreAllMocks();
});

test('redirects straight to the BDREN sign-in', () => {
  setup();

  expect(screen.getByText(/Redirecting to Sign in with BDREN/i)).toBeInTheDocument();
  expectOnlyBdrenSignIn();
});

test('shows only the BDREN button, without redirecting, right after signing out', () => {
  markExplicitLogout();
  setup();

  expect(screen.queryByText(/Redirecting to/i)).not.toBeInTheDocument();
  expect(screen.getByText('Sign in with your bdren.ai account.')).toBeInTheDocument();
  expectOnlyBdrenSignIn();
  expect(wasExplicitLogout()).toBe(false);
});

test('does not redirect when the login page is opened with redirect=false', () => {
  setup('/login?redirect=false');

  expect(screen.queryByText(/Redirecting to/i)).not.toBeInTheDocument();
  expectOnlyBdrenSignIn();
});

test('explains an account that is not linked to bdren.ai yet', () => {
  setup('/login?redirect=false&error=account_not_linked');

  expect(screen.getByText(/not linked to bdren\.ai yet/i)).toBeInTheDocument();
  expect(screen.queryByText(/Redirecting to/i)).not.toBeInTheDocument();
});
