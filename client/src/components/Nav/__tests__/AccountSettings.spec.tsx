import { render, screen, fireEvent } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import AccountSettings from '../AccountSettings';

/** Tests set only the interface links they exercise. */
type StartupConfigMock = Omit<Partial<TStartupConfig>, 'interface'> & {
  interface?: Partial<NonNullable<TStartupConfig['interface']>>;
};

let mockStartupConfig: StartupConfigMock = {};

jest.mock('recoil', () => ({
  useSetRecoilState: () => jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { showShortcutsDialog: {} },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({
    user: { name: 'Test User', email: 'test@example.com', role: 'USER' },
    isAuthenticated: true,
    logout: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useGetUserBalance: () => ({ data: undefined }),
}));

jest.mock('../Settings', () => ({ __esModule: true, default: () => null }));

jest.mock('~/components/Nav/SettingsTabs/General/ArchivedChatsModal', () => ({
  ArchivedChatsModal: () => null,
}));

const openHelpMenu = () => {
  fireEvent.click(screen.getByTestId('nav-user'));
  fireEvent.click(screen.getByText('com_nav_help'));
};

describe('AccountSettings help menu', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('lists the user guide, terms and privacy items when configured', () => {
    mockStartupConfig = {
      helpAndFaqURL: '/',
      interface: {
        userGuide: { externalUrl: '/legal/guide.html' },
        termsOfService: { externalUrl: '/legal/terms.html' },
        privacyPolicy: { externalUrl: '/legal/privacy.html' },
      },
    };
    render(<AccountSettings />);
    openHelpMenu();

    fireEvent.click(screen.getByText('com_nav_user_guide'));
    expect(openSpy).toHaveBeenCalledWith('/legal/guide.html', '_blank', 'noopener,noreferrer');
    expect(screen.getByText('com_ui_terms_of_service')).toBeInTheDocument();
    expect(screen.getByText('com_ui_privacy_policy')).toBeInTheDocument();
  });

  it('hides the user guide item when no URL is configured', () => {
    mockStartupConfig = { helpAndFaqURL: '/', interface: {} };
    render(<AccountSettings />);
    openHelpMenu();

    expect(screen.queryByText('com_nav_user_guide')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_terms_of_service')).not.toBeInTheDocument();
  });
});
