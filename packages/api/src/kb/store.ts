import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

export interface KbStoredFile {
  tenantId: string;
  extension: string;
  buffer: Buffer;
}

export interface KbFileStore {
  /** Saves a version's original and returns its `fileRef`. */
  save(file: KbStoredFile): Promise<string>;
  read(fileRef: string): Promise<Buffer>;
  remove(fileRef: string): Promise<void>;
}

const SAFE_EXTENSION = /^\.[a-z0-9]{1,8}$/;

/**
 * Keeps knowledge base originals on local disk as `<root>/kb/<tenant hash>/<uuid><ext>`: one
 * file per uploaded version, so deleting a version never touches another. The tenant is hashed
 * so its id never becomes a path segment, and every read resolves inside the root.
 */
export function createLocalKbFileStore(root: string): KbFileStore {
  const base = path.resolve(root);
  const resolve = (fileRef: string): string => {
    const full = path.resolve(base, fileRef);
    if (!full.startsWith(`${base}${path.sep}`)) {
      throw new Error('Knowledge base file reference escapes its folder');
    }
    return full;
  };

  const save = async ({ tenantId, extension, buffer }: KbStoredFile) => {
    const tenant = createHash('sha1').update(tenantId).digest('hex').slice(0, 16);
    const ext = SAFE_EXTENSION.test(extension) ? extension : '';
    const fileRef = path.posix.join('kb', tenant, `${randomUUID()}${ext}`);
    const full = resolve(fileRef);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return fileRef;
  };

  const read = (fileRef: string): Promise<Buffer> => fs.readFile(resolve(fileRef));

  const remove = async (fileRef: string): Promise<void> => {
    await fs.rm(resolve(fileRef), { force: true });
  };

  return { save, read, remove };
}
