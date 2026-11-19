import React from 'react';
import { render, screen } from '@testing-library/react';
import AccessEnded, { contactHref } from '../AccessEnded';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({ useGetUserQuery: jest.fn() }));

const message = 'Your free trial has finished. Please contact LEARN to get more usage.';

describe('contactHref', () => {
  it('mails an email address', () => {
    expect(contactHref(' help@learn.ac.lk ')).toBe('mailto:help@learn.ac.lk');
  });

  it('links an http(s) page', () => {
    expect(contactHref('https://learn.ac.lk/contact')).toBe('https://learn.ac.lk/contact');
  });

  it.each([undefined, '', 'call LEARN', 'javascript:alert(1)'])(
    'offers no link for %p',
    (value) => {
      expect(contactHref(value)).toBeNull();
    },
  );
});

describe('AccessEnded', () => {
  it("shows the institution's message, that history stays, and a contact link", () => {
    render(<AccessEnded access={{ ended: true, message, contact: 'help@learn.ac.lk' }} />);

    expect(
      screen.getByRole('status', { name: 'com_error_access_ended_title' }),
    ).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText('com_ui_access_ended_history')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'com_ui_access_ended_contact' })).toHaveAttribute(
      'href',
      'mailto:help@learn.ac.lk',
    );
  });

  it('opens a contact page in a new tab', () => {
    render(<AccessEnded access={{ ended: true, contact: 'https://learn.ac.lk/contact' }} />);
    const link = screen.getByRole('link', { name: 'com_ui_access_ended_contact' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('falls back to the default copy and hides the button without a contact', () => {
    render(<AccessEnded access={{ ended: true }} />);
    expect(screen.getByText('com_error_access_ended')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('leaves no message box to type into', () => {
    render(<AccessEnded access={{ ended: true, message }} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
