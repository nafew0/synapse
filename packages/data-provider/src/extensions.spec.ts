import {
  getEndpointFileConfig,
  normalizeExtensions,
  getExtensionAccept,
  isExtensionAllowed,
  getFileExtension,
  mergeFileConfig,
  inferMimeType,
} from './file-config';

describe('getFileExtension', () => {
  it('returns the lowercase extension without the dot', () => {
    expect(getFileExtension('Report.DOCX')).toBe('docx');
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
  });

  it('returns an empty string for names without an extension', () => {
    expect(getFileExtension('Dockerfile')).toBe('');
    expect(getFileExtension('.env')).toBe('');
    expect(getFileExtension('trailing.')).toBe('');
  });

  it('ignores dots in directory names', () => {
    expect(getFileExtension('my.folder/Makefile')).toBe('');
    expect(getFileExtension('C:\\my.folder\\scan.py')).toBe('py');
  });
});

describe('isExtensionAllowed', () => {
  const allowed = ['py', 'txt', 'docx'];

  it('allows only listed extensions', () => {
    expect(isExtensionAllowed('scan.py', allowed)).toBe(true);
    expect(isExtensionAllowed('NOTES.TXT', allowed)).toBe(true);
    expect(isExtensionAllowed('router.conf', allowed)).toBe(false);
    expect(isExtensionAllowed('Dockerfile', allowed)).toBe(false);
  });

  it('allows everything when no list is configured', () => {
    expect(isExtensionAllowed('router.conf', undefined)).toBe(true);
  });

  it('allows nothing for an empty list', () => {
    expect(isExtensionAllowed('scan.py', [])).toBe(false);
  });
});

describe('normalizeExtensions', () => {
  it('strips dots, lowercases and removes duplicates and blanks', () => {
    expect(normalizeExtensions(['.PY', 'py', ' txt ', ''])).toEqual(['py', 'txt']);
  });
});

describe('getExtensionAccept', () => {
  it('lists every extension for the picker', () => {
    expect(getExtensionAccept(['py', 'png'])).toBe('.py,.png');
  });

  it('keeps only image extensions for the image picker', () => {
    expect(getExtensionAccept(['py', 'png', 'heic', 'pdf'], { imagesOnly: true })).toBe(
      '.png,.heic',
    );
  });

  it('returns undefined without a list so callers keep their MIME filter', () => {
    expect(getExtensionAccept(undefined)).toBeUndefined();
  });
});

describe('mergeFileConfig supportedExtensions', () => {
  it('normalizes configured extensions per endpoint', () => {
    const merged = mergeFileConfig({
      endpoints: { OpenRouter: { supportedExtensions: ['.PY', 'txt'] } },
    });
    expect(merged.endpoints.OpenRouter.supportedExtensions).toEqual(['py', 'txt']);
  });

  it('falls back to the default endpoint list', () => {
    const fileConfig = mergeFileConfig({
      endpoints: { default: { supportedExtensions: ['pdf'] } },
    });
    expect(
      getEndpointFileConfig({ fileConfig, endpoint: 'someCustom' }).supportedExtensions,
    ).toEqual(['pdf']);
  });

  it('empties the list for a disabled endpoint', () => {
    const merged = mergeFileConfig({
      endpoints: { OpenRouter: { disabled: true, supportedExtensions: ['py'] } },
    });
    expect(merged.endpoints.OpenRouter.supportedExtensions).toEqual([]);
  });
});

describe('inferMimeType with misreported browser types', () => {
  it('trusts the extension over a type the browser gets wrong', () => {
    expect(inferMimeType('main.ts', 'video/mp2t')).toBe('application/typescript');
    expect(inferMimeType('Main.java', 'text/x-java-source')).toBe('text/x-java');
    expect(inferMimeType('index.php', 'text/php')).toBe('text/x-php');
    expect(inferMimeType('app.rb', 'text/x-ruby-script')).toBe('text/x-ruby');
    expect(inferMimeType('deploy.sh', 'text/x-sh')).toBe('application/x-sh');
  });

  it('keeps the browser type when the extension has no mapping', () => {
    expect(inferMimeType('clip.mts', 'video/mp2t')).toBe('video/mp2t');
    expect(inferMimeType('blob.bin', 'application/octet-stream')).toBe('application/octet-stream');
  });
});
