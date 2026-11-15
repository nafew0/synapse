import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import type { ExtendedFile } from '~/common';
import BrowserTaskButton from '../BrowserTaskButton';

type Reply = Record<string, unknown> | undefined;

function fakeChrome(replies: Record<string, Reply>) {
  const sent: Array<{ id: string; message: { type: string; text?: string; files?: unknown[] } }> =
    [];
  (window as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (
        id: string,
        message: { type: string; text?: string; files?: unknown[] },
        cb: (r?: unknown) => void,
      ) => {
        sent.push({ id, message });
        cb(replies[message.type]);
      },
    },
  };
  return sent;
}

/** The hook asks a few times whether the extension's bridge is on the page before falling back to the direct call. */
const AFTER_BRIDGE = { timeout: 4000 };

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
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument(), AFTER_BRIDGE);
  });

  it('is not shown when the browser is not signed in to Synapse', async () => {
    fakeChrome({ ping: { installed: true, version: '1.0.0', connected: false, enabled: true } });
    show(<BrowserTaskButton getText={() => 'fill my form'} onSent={jest.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument(), AFTER_BRIDGE);
  });

  it('sends what was typed, and clears the composer once it is handed over', async () => {
    const sent = fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: true },
    });
    const onSent = jest.fn();
    show(<BrowserTaskButton getText={() => '  fill my leave form  '} onSent={onSent} />);
    const button = await screen.findByRole('button', {}, AFTER_BRIDGE);
    await userEvent.click(button);
    await waitFor(() => expect(onSent).toHaveBeenCalled(), AFTER_BRIDGE);
    expect(sent.at(-1)).toEqual({
      id: expect.any(String),
      message: { type: 'task', text: 'fill my leave form', files: [] },
    });
  });

  it('names the ids of attached documents, and leaves out what the extension cannot read', async () => {
    const sent = fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: true },
    });
    const files = new Map<string, ExtendedFile>([
      [
        'a',
        { file_id: 'f1', filename: 'return.pdf', type: 'application/pdf', size: 120, progress: 1 },
      ],
      // Still uploading, an image, and a file past the size limit: none of them goes.
      [
        'b',
        { file_id: 'f2', filename: 'half.pdf', type: 'application/pdf', size: 120, progress: 0.4 },
      ],
      ['c', { file_id: 'f3', filename: 'photo.png', type: 'image/png', size: 120, progress: 1 }],
      [
        'd',
        {
          file_id: 'f4',
          filename: 'huge.pdf',
          type: 'application/pdf',
          size: 26 * 1024 * 1024,
          progress: 1,
        },
      ],
    ]);
    show(
      <BrowserTaskButton
        getText={() => 'file my return'}
        getFiles={() => files}
        onSent={jest.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole('button', {}, AFTER_BRIDGE));
    await waitFor(() => expect(sent.at(-1)?.message.files).toBeDefined(), AFTER_BRIDGE);
    expect(sent.at(-1)?.message.files).toEqual([
      { fileId: 'f1', name: 'return.pdf', mimeType: 'application/pdf', size: 120 },
    ]);
  });

  it('counts as handed over however the panel behaves', async () => {
    const onSent = jest.fn();
    fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: true },
    });
    show(<BrowserTaskButton getText={() => 'do it'} onSent={onSent} />);
    await userEvent.click(await screen.findByRole('button', {}, AFTER_BRIDGE));
    await waitFor(() => expect(onSent).toHaveBeenCalled(), AFTER_BRIDGE);
  });

  it('says what is wrong when the institution has browser tasks off', async () => {
    const onSent = jest.fn();
    const sent = fakeChrome({
      ping: { installed: true, version: '1.0.0', connected: true, enabled: true },
      task: { ok: false, reason: 'disabled' },
    });
    show(<BrowserTaskButton getText={() => 'do it'} onSent={onSent} />);
    await userEvent.click(await screen.findByRole('button', {}, AFTER_BRIDGE));
    // The composer keeps what the user typed: nothing was handed over.
    await waitFor(() => expect(sent.at(-1)?.message.type).toBe('task'), AFTER_BRIDGE);
    expect(onSent).not.toHaveBeenCalled();
  });
});
