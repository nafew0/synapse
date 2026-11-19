import { FileSources } from 'librechat-data-provider';
import { getStorageSource } from './storage';

describe('getStorageSource', () => {
  it('reads a text record from the storage that holds its original', () => {
    expect(
      getStorageSource({ source: FileSources.text, metadata: { storageSource: FileSources.s3 } }),
    ).toBe(FileSources.s3);
  });

  it('falls back to the record source when no original was stored', () => {
    expect(getStorageSource({ source: FileSources.text, metadata: {} })).toBe(FileSources.text);
    expect(getStorageSource({ source: FileSources.s3 })).toBe(FileSources.s3);
  });

  it('treats a record without a source as local', () => {
    expect(getStorageSource({ metadata: null })).toBe(FileSources.local);
  });
});
