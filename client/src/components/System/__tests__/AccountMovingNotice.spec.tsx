import React from 'react';
import { render, act } from '@testing-library/react';
import { ACCOUNT_MOVING_EVENT } from 'librechat-data-provider';
import AccountMovingNotice from '../AccountMovingNotice';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('AccountMovingNotice', () => {
  beforeEach(() => mockShowToast.mockClear());

  it('shows the localized notice once per burst of held-back requests', () => {
    const { unmount } = render(<AccountMovingNotice />);

    act(() => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_MOVING_EVENT));
      window.dispatchEvent(new CustomEvent(ACCOUNT_MOVING_EVENT));
    });

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_account_moving',
      status: 'info',
    });

    unmount();
    act(() => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_MOVING_EVENT));
    });
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});
