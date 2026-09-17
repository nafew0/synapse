import type { TAttachment } from 'librechat-data-provider';
import { findSandboxAttachment, sandboxFilename, urlTransform } from '../sandbox';

describe('sandboxFilename', () => {
  it.each([
    ['sandbox:/mnt/data/report.docx', 'report.docx'],
    ['sandbox:mnt/data/report.docx', 'report.docx'],
    ['/mnt/data/report.docx', 'report.docx'],
    ['file:///mnt/data/out/My%20Report.docx', 'My Report.docx'],
    ['sandbox:/report.docx', 'report.docx'],
  ])('resolves %s', (href, expected) => {
    expect(sandboxFilename(href)).toBe(expected);
  });

  it.each(['https://example.com/mnt/data/a.docx', '/api/files/abc/a.docx', '#top', ''])(
    'ignores %s',
    (href) => {
      expect(sandboxFilename(href)).toBeNull();
    },
  );
});

describe('urlTransform', () => {
  it('keeps sandbox links and still blanks unsafe protocols', () => {
    expect(urlTransform('sandbox:/mnt/data/report.docx')).toBe('sandbox:/mnt/data/report.docx');
    expect(urlTransform('javascript:alert(1)')).toBe('');
    expect(urlTransform('https://example.com')).toBe('https://example.com');
  });
});

describe('findSandboxAttachment', () => {
  const attachments = [
    { file_id: 'a', filename: 'notes.txt' },
    { file_id: 'b', filename: 'report.docx' },
  ] as TAttachment[];

  it('matches an attachment by file name', () => {
    expect(findSandboxAttachment(attachments, 'report.docx')).toBe(attachments[1]);
  });

  it('returns undefined when nothing matches', () => {
    expect(findSandboxAttachment(attachments, 'missing.pdf')).toBeUndefined();
    expect(findSandboxAttachment(undefined, 'report.docx')).toBeUndefined();
  });
});
