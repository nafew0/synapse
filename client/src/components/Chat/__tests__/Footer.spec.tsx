import { render, screen } from '@testing-library/react';
import Footer from '../Footer';

jest.mock('react-gtm-module', () => ({ initialize: jest.fn() }));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('Chat Footer legal links', () => {
  it('shows the privacy policy and terms links in a new tab when configured', () => {
    render(
      <Footer
        startupConfig={{
          interface: {
            privacyPolicy: { externalUrl: '/legal/privacy.html', openNewTab: true },
            termsOfService: { externalUrl: '/legal/terms.html', openNewTab: true },
          },
        }}
      />,
    );

    const privacy = screen.getByText('com_ui_privacy_policy');
    const terms = screen.getByText('com_ui_terms_of_service');
    expect(privacy).toHaveAttribute('href', '/legal/privacy.html');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('href', '/legal/terms.html');
    expect(terms).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides the legal links when none are configured', () => {
    render(<Footer startupConfig={{ interface: {} }} />);

    expect(screen.queryByText('com_ui_privacy_policy')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_terms_of_service')).not.toBeInTheDocument();
  });
});
