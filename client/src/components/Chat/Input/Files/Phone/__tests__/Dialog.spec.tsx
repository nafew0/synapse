import React from 'react';
import { render, screen } from '@testing-library/react';
import type { PhoneUploadView } from '~/hooks/Files/usePhoneUpload';
import PhoneUploadDialog from '../Dialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const view = (overrides: Partial<PhoneUploadView> = {}): PhoneUploadView => ({
  state: 'ready',
  link: 'https://synapse.test/phone/secret',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  received: [],
  phoneConnected: false,
  restart: jest.fn(),
  ...overrides,
});

describe('PhoneUploadDialog', () => {
  it('shows "Phone connected" with a status dot once the phone page is open', () => {
    render(
      <PhoneUploadDialog open onOpenChange={jest.fn()} view={view({ phoneConnected: true })} />,
    );
    const status = screen.getByTestId('phone-upload-connected');
    expect(status).toHaveTextContent('com_ui_phone_upload_connected');
    expect(status.querySelector('.bg-status-success')).not.toBeNull();
  });

  it('hides the connected status until the phone opens the link', () => {
    render(<PhoneUploadDialog open onOpenChange={jest.fn()} view={view()} />);
    expect(screen.queryByTestId('phone-upload-connected')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_phone_upload_waiting')).toBeInTheDocument();
  });
});
