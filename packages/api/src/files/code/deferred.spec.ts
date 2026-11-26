import type { TFile } from 'librechat-data-provider';
import type { CodeFileUpload } from './deferred';
import {
  deferCodeFiles,
  isDeferredCodeFile,
  hasDeferredCodeFiles,
  bringDeferredCodeFile,
  bringDeferredCodeFiles,
} from './deferred';

const image = (file_id: string): TFile =>
  ({ file_id, filename: `${file_id}.jpg`, type: 'image/jpeg', width: 768, height: 1086 }) as TFile;

const mounting = (): jest.MockedFunction<CodeFileUpload> =>
  jest.fn(async (file: TFile) => ({
    id: `sandbox-${file.file_id}`,
    resource_id: 'user-1',
    storage_session_id: 'sess-1',
    name: file.filename,
    kind: 'user' as const,
  }));

describe('deferred code files', () => {
  it('defers only images the model sees', () => {
    expect(isDeferredCodeFile(image('a'))).toBe(true);
    expect(isDeferredCodeFile({ type: 'application/pdf', width: 1, height: 1 })).toBe(false);
    expect(isDeferredCodeFile({ type: 'image/png' })).toBe(false);
  });

  it('copies nothing until asked, then each file once per request', async () => {
    const request = {};
    const upload = mounting();
    deferCodeFiles(request, [image('a'), image('b')], upload);
    expect(hasDeferredCodeFiles(request)).toBe(true);
    expect(upload).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      bringDeferredCodeFiles(request),
      bringDeferredCodeFiles(request),
    ]);
    expect(first.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(second).toEqual(first);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('shares one copy between read_document and a later code call', async () => {
    const request = {};
    const upload = mounting();
    const bytes = Buffer.from('jpeg');
    deferCodeFiles(request, [image('a')], upload);

    await bringDeferredCodeFile(request, { file_id: 'a' }, bytes);
    await bringDeferredCodeFiles(request);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(image('a'), bytes);
  });

  it('leaves a file it never deferred to the caller', () => {
    const request = {};
    deferCodeFiles(request, [image('a')], mounting());
    expect(bringDeferredCodeFile(request, { file_id: 'other' })).toBeNull();
    expect(bringDeferredCodeFile({}, { file_id: 'a' })).toBeNull();
  });

  it('tries a failed copy again on the next call instead of keeping the failure', async () => {
    const request = {};
    const upload = mounting();
    upload.mockRejectedValueOnce(new Error('sandbox down'));
    deferCodeFiles(request, [image('a')], upload);

    expect(await bringDeferredCodeFiles(request)).toEqual([]);
    expect((await bringDeferredCodeFiles(request)).map((file) => file.name)).toEqual(['a.jpg']);
  });
});
