import { FileSources } from 'librechat-data-provider';

type StoredFile = {
  source?: string | null;
  metadata?: { storageSource?: string | null } | null;
};

/**
 * The storage strategy that holds a file's bytes at its `filepath`. A `text` record's `source`
 * names how its text reaches the model, so when it also keeps the uploaded original (an editable
 * document with a sandbox copy), `metadata.storageSource` says where that original lives.
 */
export function getStorageSource(file: StoredFile): string {
  return file.metadata?.storageSource ?? file.source ?? FileSources.local;
}
