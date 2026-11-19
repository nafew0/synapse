import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import Footer from '../Footer';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const buildConfig = (overrides: Partial<TStartupConfig> = {}): TStartupConfig =>
  ({
    appTitle: 'Synapse',
    helpAndFaqURL: '',
    interface: {
      privacyPolicy: { externalUrl: '/legal/privacy.html', openNewTab: true },
      termsOfService: { externalUrl: '/legal/terms.html', openNewTab: true },
    },
    ...overrides,
  }) as TStartupConfig;

describe('Auth Footer legal links', () => {
  it('shows the privacy policy and terms links in a new tab when configured', () => {
    render(<Footer startupConfig={buildConfig()} />);

    const privacy = screen.getByText('com_ui_privacy_policy');
    const terms = screen.getByText('com_ui_terms_of_service');
    expect(privacy).toHaveAttribute('href', '/legal/privacy.html');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
    expect(terms).toHaveAttribute('href', '/legal/terms.html');
    expect(terms).toHaveAttribute('target', '_blank');
  });

  it('opens in the same tab when openNewTab is not set', () => {
    render(
      <Footer
        startupConfig={buildConfig({
          interface: { privacyPolicy: { externalUrl: '/legal/privacy.html' } },
        } as Partial<TStartupConfig>)}
      />,
    );

    expect(screen.getByText('com_ui_privacy_policy')).not.toHaveAttribute('target');
    expect(screen.queryByText('com_ui_terms_of_service')).not.toBeInTheDocument();
  });

  it('renders nothing until the startup config is available', () => {
    const { container } = render(<Footer startupConfig={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });
});
