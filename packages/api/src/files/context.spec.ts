import { FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';
import { getAttachmentTitleText, extractFileContext } from './context';

const file = (filename?: string): TFile => ({ filename }) as TFile;

describe('getAttachmentTitleText', () => {
  it('returns an empty string when there are no files', () => {
    expect(getAttachmentTitleText()).toBe('');
    expect(getAttachmentTitleText(null)).toBe('');
    expect(getAttachmentTitleText([])).toBe('');
  });

  it('lists a single filename', () => {
    expect(getAttachmentTitleText([file('report.pdf')])).toBe('Attached file(s): report.pdf');
  });

  it('lists every filename', () => {
    expect(getAttachmentTitleText([file('a.pdf'), file('b.csv')])).toBe(
      'Attached file(s): a.pdf, b.csv',
    );
  });

  it('skips files that carry no filename', () => {
    expect(getAttachmentTitleText([file(), file('kept.txt')])).toBe('Attached file(s): kept.txt');
  });

  it('returns an empty string when no file has a filename', () => {
    expect(getAttachmentTitleText([file(), file()])).toBe('');
  });
});
describe('extractFileContext', () => {
  const tokenCountFn = (text: string) => text.length;
  const req = { config: { fileConfig: {} } } as Parameters<typeof extractFileContext>[0]['req'];

  const attachment = (overrides: Partial<IMongoFile>): IMongoFile =>
    ({
      filename: 'report.pdf',
      source: FileSources.text,
      ...overrides,
    }) as IMongoFile;

  it('includes text extracted into a text-sourced record', async () => {
    const result = await extractFileContext({
      attachments: [attachment({ text: 'the whole letter' })],
      req,
      tokenCountFn,
    });

    expect(result).toContain('the whole letter');
    expect(result).toContain('report.pdf');
  });

  it('includes the preview of a file whose bytes went to the code sandbox', async () => {
    const result = await extractFileContext({
      attachments: [
        attachment({
          filename: 'budget.xlsx',
          source: FileSources.local,
          text: 'quarter,revenue',
          metadata: { preparation: { contextText: true } },
        }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toContain('quarter,revenue');
  });

  it('leaves out a searchable file that merely happens to store text', async () => {
    const result = await extractFileContext({
      attachments: [
        attachment({
          source: FileSources.local,
          text: 'indexed elsewhere',
          metadata: { preparation: { contextText: false, delivery: 'search' } },
        }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toBeUndefined();
  });

  it('returns nothing when no attachment carries text', async () => {
    expect(
      await extractFileContext({ attachments: [attachment({})], req, tokenCountFn }),
    ).toBeUndefined();
  });
});
