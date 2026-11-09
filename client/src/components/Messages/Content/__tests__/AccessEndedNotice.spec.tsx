import React from 'react';
import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { ErrorMessage } from '~/components/Chat/Messages/Content/MessageContent';
import AccessEndedNotice, { parseAccessEnded } from '../AccessEndedNotice';

jest.mock('~/hooks', () => ({
  useGenerationsByLatest: jest.requireActual('~/hooks/useGenerationsByLatest').default,
  useLocalize: () => (key: string) => key,
}));

const message = 'Your free trial has finished. Please contact LEARN to get more usage.';
const refusal = JSON.stringify({ type: 'chat_access_ended', info: message });

describe('parseAccessEnded', () => {
  it('reads the institution message from a refusal', () => {
    expect(parseAccessEnded(refusal)).toEqual({ info: message });
  });

  it('treats a refusal without a message as using the default copy', () => {
    expect(parseAccessEnded('{"type":"chat_access_ended"}')).toEqual({});
    expect(parseAccessEnded('{"type":"chat_access_ended","info":"  "}')).toEqual({});
  });

  it('ignores other errors and plain text', () => {
    expect(parseAccessEnded('{"type":"message_limit"}')).toBeUndefined();
    expect(parseAccessEnded('Something went wrong')).toBeUndefined();
    expect(parseAccessEnded('{"type":')).toBeUndefined();
  });
});

describe('AccessEndedNotice', () => {
  it("shows the institution's message under the title", () => {
    render(<AccessEndedNotice info={message} />);
    expect(screen.getByText('com_error_access_ended_title')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('falls back to the default copy', () => {
    render(<AccessEndedNotice />);
    expect(screen.getByText('com_error_access_ended')).toBeInTheDocument();
  });

  /** Admin-set text reaches the page as text, never as markup. */
  it('renders the message as plain text', () => {
    const { container } = render(<AccessEndedNotice info="<b>Contact</b> LEARN" />);
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>Contact</b> LEARN')).toBeInTheDocument();
  });
});

describe('ErrorMessage', () => {
  it('shows a refusal for ended access as a notice, without retry or report', () => {
    render(
      <RecoilRoot>
        <ErrorMessage text={refusal} />
      </RecoilRoot>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_try_again')).not.toBeInTheDocument();
  });
});
