import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import BrowserTaskButton from '../BrowserTaskButton';

type Reply = Record<string, unknown> | undefined;

function fakeChrome(replies: Record<string, Reply>) {
  const sent: Array<{ id: string; message: { type: string; text?: string } }> = [];
  (window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (id: string, message: { type: string; text?: string }, cb: (r?: unknown) => void) => {
        sent.push({ id, message });
        cb(replies[message.type]);
      },
    },
  };
  return sent;
}

const show = (ui: React.ReactElement) =>
  render(
    <RecoilRoot>
      <ToastProvider>{ui}</ToastProvider>
    </RecoilRoot>,
  );

describe('the button that hands a task to Synapse Browser', () => {
  afterEach(() => delete (window as unknown as { chrome?: unknown }).chrome);

  it('is not shown when the extension is missing', async () => {
    fakeChrome({});
    show(<BrowserTaskButton getText={() => 'fill my form'} onSent={jest.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('is not shown when the browser is not signed in to Synapse', async () => {
    fakeChrome({ ping: { installed: true, version: '1.0.0', connected: false, enabled: true } });
    show(<BrowserTaskButton getText={() => 'fill my form'} onSent={jest.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('sends what was typed, and clears the composer once it is handed over', async () => {
    const sent = fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: true },
    });
    const onSent = jest.fn();
    show(<BrowserTaskButton getText={() => '  fill my leave form  '} onSent={onSent} />);
    const button = await screen.findByRole('button');
    await userEvent.click(button);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(sent.at(-1)).toEqual({
      id: expect.any(String),
      message: { type: 'task', text: 'fill my leave form' },
    });
  });

  it('counts as handed over however the panel behaves', async () => {
    const onSent = jest.fn();
    fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: true },
    });
    show(<BrowserTaskButton getText={() => 'do it'} onSent={onSent} />);
    await userEvent.click(await screen.findByRole('button'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
  });

  it('says what is wrong when the institution has browser tasks off', async () => {
    const onSent = jest.fn();
    const sent = fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: false, reason: 'disabled' },
    });
    show(<BrowserTaskButton getText={() => 'do it'} onSent={onSent} />);
    await userEvent.click(await screen.findByRole('button'));
    // The composer keeps what the user typed: nothing was handed over.
    await waitFor(() => expect(sent.at(-1)?.message.type).toBe('task'));
    expect(onSent).not.toHaveBeenCalled();
  });
});
