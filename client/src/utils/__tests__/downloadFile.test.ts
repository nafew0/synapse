import {
  triggerDownload,
  toDownloadFilename,
  isHttpDownloadTarget,
  getCodeBlockFilename,
} from '../downloadFile';

describe('downloadFile utilities', () => {
  let clickSpy: jest.SpyInstance;
  let appendSpy: jest.SpyInstance;
  let removeSpy: jest.SpyInstance;
  let revokeSpy: jest.Mock;
  let appendedLink: HTMLAnchorElement | null;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    appendedLink = null;
    originalRevokeObjectURL = URL.revokeObjectURL;
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    appendSpy = jest.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      appendedLink = node as HTMLAnchorElement;
      return node;
    });
    removeSpy = jest.spyOn(document.body, 'removeChild').mockImplementation((node: Node) => node);
    revokeSpy = jest.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeSpy,
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    appendSpy.mockRestore();
    removeSpy.mockRestore();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    jest.useRealTimers();
  });

  it('detects absolute http download targets', () => {
    expect(isHttpDownloadTarget('https://cdn.example.com/file.pdf')).toBe(true);
    expect(isHttpDownloadTarget('http://cdn.example.com/file.pdf')).toBe(true);
    expect(isHttpDownloadTarget('blob:https://app.example.com/id')).toBe(false);
    expect(isHttpDownloadTarget('/api/files/code/download/session/file')).toBe(false);
    expect(isHttpDownloadTarget(undefined)).toBe(false);
  });

  it('navigates http URLs in the same tab without revoking them', () => {
    triggerDownload('https://cdn.example.com/file.pdf?Policy=abc', 'file.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(appendedLink?.href).toBe('https://cdn.example.com/file.pdf?Policy=abc');
    expect(appendedLink?.download).toBe('file.pdf');
    expect(appendedLink?.target).toBe('');
    expect(appendedLink?.rel).toBe('');
    jest.runOnlyPendingTimers();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('revokes blob URLs after the click', () => {
    triggerDownload('blob:https://app.example.com/download-id', 'file.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendedLink?.target).toBe('');
    expect(appendedLink?.rel).toBe('');
    expect(revokeSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:https://app.example.com/download-id');
  });
});

describe('toDownloadFilename', () => {
  it('moves the storage id to a short tail, preserving the extension', () => {
    expect(
      toDownloadFilename('550e8400-e29b-41d4-a716-446655440000-red-panda-eating-bamboo.png'),
    ).toBe('red-panda-eating-bamboo-550e84.png');
  });

  it('is case-insensitive on the hex prefix', () => {
    expect(toDownloadFilename('550E8400-E29B-41D4-A716-446655440000-red-panda.png')).toBe(
      'red-panda-550E84.png',
    );
  });

  it('keeps images of the same prompt distinct so they cannot overwrite each other', () => {
    const first = toDownloadFilename('550e8400-e29b-41d4-a716-446655440000-draw-me-cat.png');
    const second = toDownloadFilename('2b81f0aa-e29b-41d4-a716-446655440000-draw-me-cat.png');
    expect(first).not.toBe(second);
    expect(first).toBe('draw-me-cat-550e84.png');
    expect(second).toBe('draw-me-cat-2b81f0.png');
  });

  it('appends the tail at the end when there is no extension', () => {
    expect(toDownloadFilename('550e8400-e29b-41d4-a716-446655440000-red-panda')).toBe(
      'red-panda-550e84',
    );
  });

  it('leaves filenames without a storage prefix unchanged', () => {
    expect(toDownloadFilename('red-panda-eating-bamboo.png')).toBe('red-panda-eating-bamboo.png');
  });

  it('leaves a bare storage id unchanged rather than returning an empty name', () => {
    expect(toDownloadFilename('550e8400-e29b-41d4-a716-446655440000-')).toBe(
      '550e8400-e29b-41d4-a716-446655440000-',
    );
  });
});

describe('getCodeBlockFilename', () => {
  it('maps common language names to their extension', () => {
    expect(getCodeBlockFilename('python')).toBe('code.py');
    expect(getCodeBlockFilename('javascript')).toBe('code.js');
    expect(getCodeBlockFilename('typescript')).toBe('code.ts');
    expect(getCodeBlockFilename('csharp')).toBe('code.cs');
    expect(getCodeBlockFilename('c++')).toBe('code.cpp');
    expect(getCodeBlockFilename('bash')).toBe('code.sh');
    expect(getCodeBlockFilename('shell')).toBe('code.sh');
    expect(getCodeBlockFilename('powershell')).toBe('code.ps1');
    expect(getCodeBlockFilename('markdown')).toBe('code.md');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(getCodeBlockFilename('Python')).toBe('code.py');
    expect(getCodeBlockFilename(' RUST ')).toBe('code.rs');
  });

  it('maps alphanumeric language aliases instead of treating them as extensions', () => {
    expect(getCodeBlockFilename('python3')).toBe('code.py');
    expect(getCodeBlockFilename('nodejs')).toBe('code.js');
    expect(getCodeBlockFilename('node')).toBe('code.js');
    expect(getCodeBlockFilename('golang')).toBe('code.go');
  });

  it('passes extension-like hints through unchanged', () => {
    expect(getCodeBlockFilename('py')).toBe('code.py');
    expect(getCodeBlockFilename('tsx')).toBe('code.tsx');
    expect(getCodeBlockFilename('json')).toBe('code.json');
    expect(getCodeBlockFilename('svg')).toBe('code.svg');
    expect(getCodeBlockFilename('html')).toBe('code.html');
    expect(getCodeBlockFilename('toml')).toBe('code.toml');
  });

  it('falls back to .txt for missing or unusable hints', () => {
    expect(getCodeBlockFilename(undefined)).toBe('code.txt');
    expect(getCodeBlockFilename(null)).toBe('code.txt');
    expect(getCodeBlockFilename('')).toBe('code.txt');
    expect(getCodeBlockFilename('plaintext')).toBe('code.txt');
    expect(getCodeBlockFilename('not a language')).toBe('code.txt');
    expect(getCodeBlockFilename('../../etc/passwd')).toBe('code.txt');
  });
});
