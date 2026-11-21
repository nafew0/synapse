import React from 'react';
import { dataService } from 'librechat-data-provider';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PhoneUploadFile, PhoneUploadSession } from 'librechat-data-provider';
import usePhoneUpload, { buildPhoneLink, usePhoneSession } from '../usePhoneUpload';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      createPhoneUploadSession: jest.fn(),
      getPhoneUploadSession: jest.fn(),
      downloadPhoneUploadFile: jest.fn(),
      closePhoneUploadSession: jest.fn(),
    },
  };
});

const mocked = dataService as jest.Mocked<typeof dataService>;

const staged = (fileId: string, filename: string): PhoneUploadFile => ({
  fileId,
  filename,
  mimeType: 'image/jpeg',
  bytes: 1,
  uploadedAt: new Date().toISOString(),
});

const session = (files: PhoneUploadFile[], phoneConnected = false): PhoneUploadSession => ({
  sessionId: 'session-1',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  maxFiles: 20,
  phoneConnected,
  files,
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('usePhoneSession', () => {
  const close = mocked.closePhoneUploadSession;
  const download = mocked.downloadPhoneUploadFile;
  const getSession = mocked.getPhoneUploadSession;

  beforeEach(() => {
    jest.resetAllMocks();
    mocked.createPhoneUploadSession.mockResolvedValue({
      sessionId: 'session-1',
      token: 'secret token',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    download.mockImplementation(async (_s, fileId) => new Blob([fileId], { type: 'image/jpeg' }));
    close.mockResolvedValue(undefined);
  });

  it('hands each phone file to the chat once', async () => {
    getSession
      .mockResolvedValueOnce(session([staged('a', 'one.jpg'), staged('b', 'two.jpg')]))
      .mockResolvedValue(session([staged('a', 'one.jpg'), staged('b', 'two.jpg')]));
    const onFiles = jest.fn();
    const { result } = renderHook(
      () => usePhoneSession({ active: true, endpoint: 'agents', onFiles, onFileError: jest.fn() }),
      { wrapper },
    );

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    const files = onFiles.mock.calls[0][0] as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([
      ['one.jpg', 'image/jpeg'],
      ['two.jpg', 'image/jpeg'],
    ]);
    expect(result.current.state).toBe('ready');
    expect(result.current.received).toHaveLength(2);
    expect(result.current.link).toBe(buildPhoneLink('secret token'));

    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(1), {
      timeout: 4000,
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it('reports a file it could not fetch and still adds the rest', async () => {
    getSession.mockResolvedValue(session([staged('bad', 'bad.jpg'), staged('ok', 'ok.jpg')]));
    download.mockImplementation(async (_s, fileId) => {
      if (fileId === 'bad') {
        throw new Error('network');
      }
      return new Blob(['ok']);
    });
    const onFiles = jest.fn();
    const onFileError = jest.fn();
    renderHook(() => usePhoneSession({ active: true, onFiles, onFileError }), { wrapper });

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect((onFiles.mock.calls[0][0] as File[]).map((file) => file.name)).toEqual(['ok.jpg']);
    expect(onFileError).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'bad' }));
  });

  it('shows the phone as connected while the server sees it checking in', async () => {
    getSession.mockResolvedValue(session([], true));
    const { result } = renderHook(
      () => usePhoneSession({ active: true, onFiles: jest.fn(), onFileError: jest.fn() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.phoneConnected).toBe(true));
  });

  it('shows the code as expired once the server says the session ended', async () => {
    getSession.mockRejectedValue({ response: { status: 410 } });
    const { result } = renderHook(
      () => usePhoneSession({ active: true, onFiles: jest.fn(), onFileError: jest.fn() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state).toBe('expired'));
  });

  it('closes the session when the dialog closes', async () => {
    getSession.mockResolvedValue(session([]));
    const { result, rerender } = renderHook(
      ({ open }) => usePhoneSession({ active: open, onFiles: jest.fn(), onFileError: jest.fn() }),
      { wrapper, initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.state).toBe('ready'));
    act(() => rerender({ open: false }));
    expect(close).toHaveBeenCalledWith('session-1');
  });
});

describe('usePhoneUpload', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mocked.createPhoneUploadSession.mockResolvedValue({
      sessionId: 'session-1',
      token: 'secret',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    mocked.downloadPhoneUploadFile.mockResolvedValue(new Blob(['x']));
    mocked.closePhoneUploadSession.mockResolvedValue(undefined);
  });

  it('closes the dialog when files arrive and keeps the code working', async () => {
    mocked.getPhoneUploadSession.mockResolvedValue(session([staged('a', 'scan.pdf')]));
    const onFiles = jest.fn();
    const { result } = renderHook(
      () => usePhoneUpload({ conversationId: 'c1', onFiles, onFileError: jest.fn() }),
      { wrapper },
    );
    act(() => result.current.openDialog());
    expect(result.current.isDialogOpen).toBe(true);

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(result.current.isDialogOpen).toBe(false);
    expect(mocked.closePhoneUploadSession).not.toHaveBeenCalled();
    expect(result.current.view.state).toBe('ready');
  });

  it('ends the code when the dialog is closed before anything arrived', async () => {
    mocked.getPhoneUploadSession.mockResolvedValue(session([]));
    const { result } = renderHook(
      () => usePhoneUpload({ conversationId: 'c1', onFiles: jest.fn(), onFileError: jest.fn() }),
      { wrapper },
    );
    act(() => result.current.openDialog());
    await waitFor(() => expect(result.current.view.state).toBe('ready'));
    act(() => result.current.setDialogOpen(false));
    expect(mocked.closePhoneUploadSession).toHaveBeenCalledWith('session-1');
  });

  it('ends the code when the user switches to another chat', async () => {
    mocked.getPhoneUploadSession.mockResolvedValue(session([staged('a', 'scan.pdf')]));
    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        usePhoneUpload({ conversationId, onFiles: jest.fn(), onFileError: jest.fn() }),
      { wrapper, initialProps: { conversationId: 'c1' } },
    );
    act(() => result.current.openDialog());
    await waitFor(() => expect(result.current.isDialogOpen).toBe(false));
    act(() => rerender({ conversationId: 'c2' }));
    expect(mocked.closePhoneUploadSession).toHaveBeenCalledWith('session-1');
  });
});
