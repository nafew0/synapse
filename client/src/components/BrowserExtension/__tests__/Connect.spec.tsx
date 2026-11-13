import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Connect from '../Connect';

const mockCode = {
  mutate: jest.fn(),
  isLoading: false,
  isError: false,
  data: undefined as unknown,
};
const mockSignOut = { mutate: jest.fn(), isLoading: false, data: undefined as unknown };

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));
jest.mock('~/data-provider', () => ({
  useBrowserExtensionCode: () => mockCode,
  useSignOutBrowserExtensions: () => mockSignOut,
}));

describe('Connect', () => {
  beforeEach(() => {
    mockCode.mutate.mockClear();
    mockSignOut.mutate.mockClear();
    mockCode.data = undefined;
    mockCode.isError = false;
    mockSignOut.data = undefined;
  });

  it('asks for a code on request', () => {
    render(<Connect />);
    fireEvent.click(screen.getByText('com_ui_browser_ext_get_code'));
    expect(mockCode.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows the code and when it expires', () => {
    mockCode.data = { code: 'ABCD-EFGH', expiresAt: '2026-11-13T10:00:00.000Z' };
    render(<Connect />);
    expect(screen.getByLabelText('com_ui_browser_ext_code_label')).toHaveTextContent('ABCD-EFGH');
    expect(screen.getByText('com_ui_browser_ext_new_code')).toBeInTheDocument();
  });

  it('says so when no code can be had', () => {
    mockCode.isError = true;
    render(<Connect />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_browser_ext_error');
  });

  it('signs out every extension and reports how many', () => {
    mockSignOut.data = { removed: 2 };
    render(<Connect />);
    fireEvent.click(screen.getByText('com_ui_browser_ext_sign_out'));
    expect(mockSignOut.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('com_ui_browser_ext_signed_out 2')).toBeInTheDocument();
  });
});
