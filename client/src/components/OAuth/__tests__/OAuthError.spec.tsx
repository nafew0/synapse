import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OAuthError, { getOAuthErrorKey } from '../OAuthError';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => `localized:${key}`,
}));

describe('getOAuthErrorKey', () => {
  it.each([
    ['missing_code', 'com_ui_oauth_error_missing_code'],
    ['missing_state', 'com_ui_oauth_error_missing_state'],
    ['invalid_state', 'com_ui_oauth_error_invalid_state'],
    ['callback_failed', 'com_ui_oauth_error_callback_failed'],
    ['token_exchange_failed_at_provider', 'com_ui_oauth_error_generic'],
    [null, 'com_ui_oauth_error_generic'],
  ])('maps %s to %s', (error, key) => {
    expect(getOAuthErrorKey(error)).toBe(key);
  });
});

describe('OAuthError', () => {
  it('never renders the raw error query parameter', () => {
    render(
      <MemoryRouter initialEntries={['/oauth/error?error=invalid_client_secret_for_provider']}>
        <OAuthError />
      </MemoryRouter>,
    );
    expect(screen.getByText('localized:com_ui_oauth_error_generic')).toBeInTheDocument();
    expect(screen.queryByText(/invalid client secret/i)).not.toBeInTheDocument();
  });
});
